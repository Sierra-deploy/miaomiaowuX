// securechan.ts — 前端 ↔ 后端 E2E 加密客户端
//
// 1:1 复刻 internal/securechan/ 协议栈:
//   - X25519 ECDH(@noble/curves)
//   - HKDF-SHA256(@noble/hashes)派生 send/recv 双向 AES-256-GCM 密钥
//   - 二进制 envelope: [version(1)=0x01][seq(8 big-endian)][AES-GCM ciphertext + 16B tag]
//   - 64-bit 滑动窗口防重放(接收方)
//
// 协议常量必须与 internal/handler/securechan_user.go 一致。

import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const ENVELOPE_VERSION = 0x01
const NONCE_SIZE = 12
const WINDOW_SIZE = 64n

const HEADER_SECURE_CHANNEL = 'X-Secure-Channel'
const HEADER_SESSION_ID = 'X-Session-Id'
const HEADER_SECURE_CHANNEL_EXPIRED = 'X-Secure-Channel-Expired'
const SECURE_CHANNEL_VERSION = 'v1'

interface ClientSession {
  sessionId: string
  sendKey: CryptoKey
  recvKey: CryptoKey
  sendNonceBase: Uint8Array  // 12B,seq 后 8 字节会被覆写
  recvNonceBase: Uint8Array
  sendSeq: bigint           // 上一次发送的 seq;下一次发送先 ++
  recvMaxSeq: bigint
  recvBitmap: bigint
}

class SecureChannelClient {
  private session: ClientSession | null = null
  private handshakeInFlight: Promise<void> | null = null

  isReady(): boolean {
    return this.session !== null
  }

  getSessionId(): string | null {
    return this.session?.sessionId ?? null
  }

  reset(): void {
    this.session = null
    this.handshakeInFlight = null
  }

  /**
   * 与后端做一次 ECDH 握手并建立会话。并发调用合并到同一个 in-flight promise,
   * 避免页面 hydration 时多个请求同时触发多次握手。
   *
   * doHandshakeRequest 是注入的"发请求"函数,由调用方(axios 实例)提供,以避免循环依赖。
   */
  async handshake(
    doHandshakeRequest: (clientPubB64: string) => Promise<{ session_id: string; server_pub_b64: string }>
  ): Promise<void> {
    if (this.handshakeInFlight) {
      return this.handshakeInFlight
    }
    this.handshakeInFlight = this.doHandshake(doHandshakeRequest).finally(() => {
      this.handshakeInFlight = null
    })
    return this.handshakeInFlight
  }

  private async doHandshake(
    doHandshakeRequest: (clientPubB64: string) => Promise<{ session_id: string; server_pub_b64: string }>
  ): Promise<void> {
    const clientPriv = x25519.utils.randomSecretKey()
    const clientPub = x25519.getPublicKey(clientPriv)
    const clientPubB64 = bytesToBase64(clientPub)

    const resp = await doHandshakeRequest(clientPubB64)
    const serverPub = base64ToBytes(resp.server_pub_b64)
    if (serverPub.length !== 32) {
      throw new Error('invalid server_pub length')
    }

    const shared = x25519.getSharedSecret(clientPriv, serverPub)

    // HKDF salt = clientPub + serverPub(对应后端 agentEphPub + masterEphPub,client=agent,server=master)
    const salt = new Uint8Array(clientPub.length + serverPub.length)
    salt.set(clientPub, 0)
    salt.set(serverPub, clientPub.length)

    // 后端 hkdf 顺序:m2aKey(32) + a2mKey(32) + m2aNonce(12) + a2mNonce(12) = 88 bytes
    // 前端是 agent(isMaster=false)→ 发送用 a2mKey/a2mNonce,接收用 m2aKey/m2aNonce
    const okm = hkdf(sha256, shared, salt, new TextEncoder().encode('securechan-v1'), 88)
    const m2aKey = okm.slice(0, 32)
    const a2mKey = okm.slice(32, 64)
    const m2aNonce = okm.slice(64, 76)
    const a2mNonce = okm.slice(76, 88)

    const sendKey = await crypto.subtle.importKey('raw', a2mKey as BufferSource, 'AES-GCM', false, ['encrypt'])
    const recvKey = await crypto.subtle.importKey('raw', m2aKey as BufferSource, 'AES-GCM', false, ['decrypt'])

    this.session = {
      sessionId: resp.session_id,
      sendKey,
      recvKey,
      sendNonceBase: new Uint8Array(a2mNonce),
      recvNonceBase: new Uint8Array(m2aNonce),
      sendSeq: 0n,
      recvMaxSeq: 0n,
      recvBitmap: 0n,
    }
  }

  /**
   * 把明文加密成 base64 编码的 envelope 字符串。
   * 为什么不直接发 binary?某些 WAF / CDN(阿里云 WAF / Cloudflare 等)会对
   * application/octet-stream binary body 做"智能扫描"或编码失真,导致密文到达后端时已破损。
   * 用 base64 ASCII 文本传输是最稳的方式,所有 CDN 都不会改 ASCII。
   */
  async encryptBodyB64(plaintext: Uint8Array): Promise<string> {
    if (!this.session) throw new Error('secure channel not established')
    const s = this.session
    // RACE BUG FIX:必须把本次发送的 seq 锁到 local 变量,不能在 await 之后再读 s.sendSeq。
    //
    // 老逻辑:
    //   s.sendSeq = s.sendSeq + 1n               // caller A:5
    //   nonce = makeNonce(..., s.sendSeq)        // nonce(5)
    //   await crypto.subtle.encrypt(nonce, ...)  // ← 让出执行权
    //                                            // 期间 caller B 进:s.sendSeq=6
    //   writeBigUint64BE(envelope, 1, s.sendSeq) // ← 读到 6!但密文是 nonce(5)
    //
    // 结果:envelope 头是 seq=6 + 用 nonce(5) 加密的密文 → 服务器用 nonce(6) 解 → AES-GCM
    // 认证失败 → 报 "decrypt failed"。任何并发的 securechan 请求(同 mutation 链、
    // useQuery 同时 refetch 等)都会踩到。
    s.sendSeq = s.sendSeq + 1n
    const localSeq = s.sendSeq
    const nonce = makeNonce(s.sendNonceBase, localSeq)
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, s.sendKey, plaintext as BufferSource)
    )
    const envelope = new Uint8Array(1 + 8 + ct.length)
    envelope[0] = ENVELOPE_VERSION
    writeBigUint64BE(envelope, 1, localSeq)
    envelope.set(ct, 9)
    return bytesToBase64(envelope)
  }

  /**
   * 反向:base64 → envelope → seq 滑动窗口校验 → 解密返回明文。
   */
  async decryptBodyB64(envelopeB64: string): Promise<Uint8Array> {
    if (!this.session) throw new Error('secure channel not established')
    const s = this.session
    const envelope = base64ToBytes(envelopeB64.trim())
    if (envelope.length < 1 + 8 + 16) throw new Error('envelope too short')
    if (envelope[0] !== ENVELOPE_VERSION) throw new Error('unknown envelope version')

    const seq = readBigUint64BE(envelope, 1)
    if (!checkReplayWindow(s, seq)) {
      throw new Error(`replay or out-of-window seq: ${seq}`)
    }
    const nonce = makeNonce(s.recvNonceBase, seq)
    const pt = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, s.recvKey, envelope.slice(9) as BufferSource)
    )
    return pt
  }
}

export const secureChannel = new SecureChannelClient()

// 协议常量给 axios 拦截器和测试用
export const SECURE_CHANNEL_CONSTANTS = {
  VERSION: SECURE_CHANNEL_VERSION,
  HEADER: HEADER_SECURE_CHANNEL,
  SESSION_ID_HEADER: HEADER_SESSION_ID,
  EXPIRED_HEADER: HEADER_SECURE_CHANNEL_EXPIRED,
}

// ===== 私有 helpers =====

function makeNonce(base: Uint8Array, seq: bigint): Uint8Array {
  // 严格复刻后端 securechan.go:makeNonce:
  //   nonce = base                              (12 字节)
  //   seqBytes = [0,0,0,0, BE_seq (8 字节)]      (12 字节)
  //   nonce[i] ^= seqBytes[i]   (整 12 字节 XOR)
  // 等同于:nonce[0..4] = base[0..4](因为 ^0 不变),nonce[4..12] = base[4..12] XOR BE_seq
  const nonce = new Uint8Array(NONCE_SIZE)
  nonce.set(base, 0)
  // 把 seq 写成 BE 8 字节到一个临时缓冲,再 XOR 到 nonce[4..12]
  const seqBE = new Uint8Array(8)
  new DataView(seqBE.buffer).setBigUint64(0, seq, false)
  for (let i = 0; i < 8; i++) {
    nonce[4 + i] ^= seqBE[i]
  }
  return nonce
}

function checkReplayWindow(s: ClientSession, seq: bigint): boolean {
  if (seq === 0n) return false
  if (seq > s.recvMaxSeq) {
    const shift = seq - s.recvMaxSeq
    if (shift >= WINDOW_SIZE) {
      s.recvBitmap = 0n
    } else {
      s.recvBitmap = (s.recvBitmap << shift) & ((1n << 64n) - 1n)
    }
    s.recvMaxSeq = seq
    s.recvBitmap = s.recvBitmap | 1n
    return true
  }
  const diff = s.recvMaxSeq - seq
  if (diff >= WINDOW_SIZE) return false
  const bit = 1n << diff
  if ((s.recvBitmap & bit) !== 0n) return false
  s.recvBitmap = s.recvBitmap | bit
  return true
}

function writeBigUint64BE(buf: Uint8Array, offset: number, val: bigint): void {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8)
  view.setBigUint64(0, val, false)
}

function readBigUint64BE(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8)
  return view.getBigUint64(0, false)
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
