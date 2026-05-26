// @ts-nocheck
import { useState, useMemo, useEffect } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Copy,
  Database,
  ExternalLink,
  FileWarning,
  Loader2,
  ShieldCheck,
  Terminal,
  Upload,
} from 'lucide-react'

import { Topbar } from '@/components/layout/topbar'
import { api } from '@/lib/api'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/migrate-from-mmw/')({
  component: MigratePage,
})

const STEPS = [
  { id: 1, title: '概述与前置', icon: ShieldCheck },
  { id: 2, title: '停止 mmw + 备份', icon: FileWarning },
  { id: 3, title: '导入 mmw 数据库', icon: Database },
  { id: 4, title: '认领节点 / 用户', icon: Upload },
  { id: 5, title: '验证并完成', icon: CheckCircle2 },
] as const

type AutoBackup = {
  backup_path: string
  db_path: string
  subscribes_dir: string
  subscribe_count: number
  size_bytes: number
  db_size_bytes: number
} | null

function MigratePage() {
  const [step, setStep] = useState(1)
  const [autoBackup, setAutoBackup] = useState<AutoBackup>(null) // Step 2 自动模式拿到的备份信息,Step 3 复用
  const goNext = () => setStep((s) => Math.min(s + 1, STEPS.length))
  const goBack = () => setStep((s) => Math.max(s - 1, 1))

  return (
    <div className='min-h-svh bg-background'>
      <Topbar />
      <main className='mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 pt-24'>
        {/* Header */}
        <section className='mb-6 space-y-2'>
          <div className='flex items-center gap-2'>
            <Badge variant='outline' className='text-xs'>管理员功能</Badge>
            <Badge variant='secondary' className='text-xs'>一次性迁移</Badge>
          </div>
          <h1 className='text-3xl font-semibold tracking-tight'>从妙妙屋迁移到妙妙屋X</h1>
          <p className='text-sm text-muted-foreground'>
            本向导引导你把妙妙屋(mmw)的数据迁移到当前妙妙屋X 实例。全程不动 nginx、不重发证书、不让客户端换订阅 URL。
            预计耗时 10–30 分钟,客户端在迁移期间会有 1–2 分钟短暂断连。
          </p>
        </section>

        {/* Stepper */}
        <Stepper current={step} onJump={setStep} />

        {/* Body */}
        <div className='mt-6 space-y-6'>
          {step === 1 && <Step1Overview onNext={goNext} />}
          {step === 2 && <Step2BackupAndStopMmw onBack={goBack} onNext={goNext} autoBackup={autoBackup} setAutoBackup={setAutoBackup} />}
          {step === 3 && <Step3ImportDB onBack={goBack} onNext={goNext} autoBackup={autoBackup} />}
          {step === 4 && <Step4Claim onBack={goBack} onNext={goNext} />}
          {step === 5 && <Step5Verify onBack={goBack} />}
        </div>
      </main>
    </div>
  )
}

/* -------------------- Stepper UI -------------------- */

function Stepper({ current, onJump }: { current: number; onJump: (n: number) => void }) {
  return (
    <div className='flex items-stretch gap-1 rounded-lg border bg-muted/30 p-1 overflow-hidden'>
      {STEPS.map((s, idx) => {
        const Icon = s.icon
        const done = current > s.id
        const active = current === s.id
        const isLast = idx === STEPS.length - 1
        return (
          <div key={s.id} className='flex flex-1 min-w-0 items-stretch'>
            <button
              onClick={() => onJump(s.id)}
              className={cn(
                'flex flex-1 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs sm:text-sm transition-colors',
                active && 'bg-primary text-primary-foreground',
                !active && done && 'text-primary hover:bg-primary/10',
                !active && !done && 'text-muted-foreground hover:bg-accent',
              )}
            >
              <span className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium',
                active && 'border-primary-foreground',
                !active && done && 'border-primary bg-primary/10',
                !active && !done && 'border-border',
              )}>
                {done ? <CheckCircle2 className='size-4' /> : s.id}
              </span>
              <span className='hidden sm:inline-flex flex-1 min-w-0 items-center gap-1.5'>
                <Icon className='size-3.5 shrink-0' />
                <span className='truncate'>{s.title}</span>
              </span>
            </button>
            {!isLast && (
              <span className='hidden md:flex shrink-0 items-center px-0.5 text-muted-foreground/40'>
                <ArrowRight className='size-3' />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* -------------------- Step 1: Overview -------------------- */

function Step1Overview({ onNext }: { onNext: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>欢迎使用迁移向导</CardTitle>
        <CardDescription>
          开始前请通读以下要点,确认无误后再进入下一步。
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 text-sm'>
        <Alert>
          <ShieldCheck className='h-4 w-4' />
          <AlertTitle>迁移保证</AlertTitle>
          <AlertDescription>
            <ul className='ml-4 mt-2 space-y-1 list-disc'>
              <li><strong>客户端订阅 URL 不变</strong> — 用户的 Clash / Shadowrocket 不用改</li>
              <li><strong>xray UUID / password 不变</strong> — 协议层无感切换</li>
              <li><strong>nginx 配置不动</strong> — 反代继续指向同一个端口</li>
              <li><strong>SSL 证书不动</strong> — certbot 不需要重新申请</li>
              <li><strong>mmw 不会被删除</strong> — systemctl 只是停掉服务,失败可回滚</li>
            </ul>
          </AlertDescription>
        </Alert>

        <Alert variant='destructive'>
          <FileWarning className='h-4 w-4' />
          <AlertTitle>前置要求</AlertTitle>
          <AlertDescription>
            <ul className='ml-4 mt-2 space-y-1 list-disc'>
              <li>你已经把妙妙屋X 二进制装好,并通过 systemd 跑在 mmw 同一端口上</li>
              <li>当前 mmwx 数据库<strong>是空的</strong>(无套餐 / 节点 / 用户) — 否则会被 mmw 数据覆盖</li>
              <li>具备 root SSH 访问到部署 mmw 的机器</li>
              <li>所有 mmw 时代的远程节点服务器都已安装 <code className='bg-muted px-1 py-0.5 rounded'>mmw-agent</code> 并接入 mmwx 主控</li>
            </ul>
          </AlertDescription>
        </Alert>

        <div className='rounded-lg border p-4'>
          <h3 className='mb-2 font-medium'>迁移流程概览</h3>
          <ol className='ml-4 space-y-1 text-muted-foreground list-decimal'>
            <li><strong>停止 mmw 并备份</strong> — 防止数据继续变化 + 失败回滚</li>
            <li><strong>导入 mmw.db</strong> — 上传 / 填路径,主控读取并迁移 schema</li>
            <li><strong>认领节点 / 用户</strong> — 把 xray 现有 client 绑定到 mmwx 用户</li>
            <li><strong>验证并完成</strong> — 测一个客户端订阅 URL 是否仍可用</li>
          </ol>
        </div>

        <div className='flex items-center justify-between rounded-md border bg-muted/30 p-3 text-xs'>
          <span className='text-muted-foreground'>
            读完详细文档 →
          </span>
          <a
            href='https://www.miaomiaowu.net/x/docs/upgrade-from-mmw'
            target='_blank'
            rel='noreferrer'
            className='inline-flex items-center gap-1 text-primary hover:underline'
          >
            升级指南完整版 <ExternalLink className='size-3' />
          </a>
        </div>
      </CardContent>
      <CardContent className='flex justify-end pt-0'>
        <Button onClick={onNext}>
          我已了解,开始 <ArrowRight className='ml-2 size-4' />
        </Button>
      </CardContent>
    </Card>
  )
}

/* -------------------- Step 2: Stop mmw & backup -------------------- */

function Step2BackupAndStopMmw({ onBack, onNext, autoBackup, setAutoBackup }: { onBack: () => void; onNext: () => void; autoBackup: AutoBackup; setAutoBackup: (b: AutoBackup) => void }) {
  const [mode, setMode] = useState<'auto' | 'manual'>('auto')

  return (
    <Card>
      <CardHeader>
        <CardTitle>停止 mmw 并备份关键数据</CardTitle>
        <CardDescription>
          这一步要做两件事:① 把妙妙屋数据库备份出来 → ② 停止妙妙屋服务防止数据继续变化。
          可以选择"自动拉取"或"手动操作"。
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='flex items-center gap-2 text-sm'>
          <Button
            variant={mode === 'auto' ? 'default' : 'outline'}
            size='sm'
            onClick={() => setMode('auto')}
          >
            <Upload className='mr-2 size-4 rotate-180' />自动从妙妙屋拉取备份
          </Button>
          <Button
            variant={mode === 'manual' ? 'default' : 'outline'}
            size='sm'
            onClick={() => setMode('manual')}
          >
            <Terminal className='mr-2 size-4' />手动备份 + 停服
          </Button>
        </div>

        {mode === 'auto' ? <AutoBackupForm onNext={onNext} autoBackup={autoBackup} setAutoBackup={setAutoBackup} /> : <ManualBackupSteps onNext={onNext} />}
      </CardContent>
      <CardContent className='flex justify-between pt-0'>
        <Button variant='outline' onClick={onBack}>上一步</Button>
        {/* 下一步按钮在子表单内,按场景决定 enable 时机 */}
      </CardContent>
    </Card>
  )
}

function AutoBackupForm({ onNext, autoBackup, setAutoBackup }: { onNext: () => void; autoBackup: AutoBackup; setAutoBackup: (b: AutoBackup) => void }) {
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [fetching, setFetching] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopped, setStopped] = useState(false)
  const result = autoBackup

  const fetchBackup = async () => {
    if (!url.trim() || !username.trim() || !password.trim()) {
      toast.error('请填妙妙屋地址 / 账号 / 密码')
      return
    }
    setFetching(true)
    try {
      const resp = await api.post('/api/admin/migrate/fetch-mmw-backup', {
        url: url.trim(),
        username: username.trim(),
        password,
        totp: totp.trim(),
      }, { timeout: 5 * 60 * 1000 })
      const d = resp.data as AutoBackup & { subscribes_dir: string; subscribe_count: number }
      setAutoBackup({
        backup_path: d!.backup_path,
        db_path: d!.db_path,
        subscribes_dir: d!.subscribes_dir,
        subscribe_count: d!.subscribe_count,
        size_bytes: d!.size_bytes,
        db_size_bytes: d!.db_size_bytes,
      })
      toast.success(`备份已拉取 (${(d!.size_bytes / 1024 / 1024).toFixed(1)} MB, 订阅文件 ${d!.subscribe_count} 个)`)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || e?.message || '拉取失败')
    } finally {
      setFetching(false)
    }
  }

  const stopMmw = async () => {
    setStopping(true)
    // 占位:后端接口 POST /api/admin/migrate/stop-mmw  (用同一组凭据登录,调 mmw 的 systemctl 子命令或:让用户手工执行)
    setTimeout(() => {
      setStopped(true)
      setStopping(false)
      toast.info('UI 占位 — 妙妙屋自身没有 stop-self API,实际可能引导用户手工执行')
    }, 800)
  }

  return (
    <div className='space-y-3'>
      <Alert>
        <ShieldCheck className='h-4 w-4' />
        <AlertTitle>自动拉取做了什么</AlertTitle>
        <AlertDescription className='text-xs mt-1'>
          主控会用你提供的账号登录妙妙屋,调用其 <code className='bg-muted px-1 py-0.5 rounded'>/api/admin/backup/download</code> 接口拉取完整备份(数据库 + 订阅文件)到本地 <code className='bg-muted px-1 py-0.5 rounded'>/tmp/mmwx-migrate/</code>,
          然后(可选)远程触发停服。账号密码<strong>不持久化</strong>,只在本次操作中转。
        </AlertDescription>
      </Alert>

      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-1 sm:col-span-2'>
          <Label className='text-xs'>妙妙屋地址</Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder='https://mmw.your-domain.com'
            disabled={Boolean(result)}
          />
          <p className='text-[10px] text-muted-foreground'>不带尾斜杠,例如 https://mmw.example.com 或 http://1.2.3.4:9090</p>
        </div>
        <div className='space-y-1'>
          <Label className='text-xs'>管理员用户名</Label>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete='off'
            disabled={Boolean(result)}
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-xs'>密码</Label>
          <Input
            type='password'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete='new-password'
            disabled={Boolean(result)}
          />
        </div>
        <div className='space-y-1 sm:col-span-2'>
          <Label className='text-xs'>两步验证码(若启用)</Label>
          <Input
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            placeholder='留空 = 未启用 2FA'
            inputMode='numeric'
            maxLength={6}
            disabled={Boolean(result)}
          />
        </div>
      </div>

      {!result ? (
        <div className='flex justify-end'>
          <Button onClick={fetchBackup} disabled={fetching}>
            {fetching ? (
              <><Loader2 className='mr-2 size-4 animate-spin' />拉取中…</>
            ) : (
              <><Database className='mr-2 size-4' />测试连接 + 拉取备份</>
            )}
          </Button>
        </div>
      ) : (
        <Alert>
          <CheckCircle2 className='h-4 w-4' />
          <AlertTitle>备份已拉取</AlertTitle>
          <AlertDescription className='mt-2 text-xs space-y-1'>
            <div>本地暂存:<code className='bg-muted px-1 py-0.5 rounded'>{result.backup_path}</code></div>
            <div>
              归档大小:{(result.size_bytes / 1024 / 1024).toFixed(2)} MB ·
              数据库:{(result.db_size_bytes / 1024 / 1024).toFixed(2)} MB ·
              订阅文件:{result.subscribe_count} 个
            </div>
            <div className='text-muted-foreground'>下一步会用这个备份做导入,无需再上传文件。</div>
          </AlertDescription>
        </Alert>
      )}

      {result && (
        <div className='rounded-md border bg-muted/20 p-3 space-y-2'>
          <div className='flex items-center justify-between'>
            <div className='text-sm font-medium'>{stopped ? '✅ 已停止 mmw' : '停止妙妙屋服务'}</div>
            {!stopped && (
              <Button size='sm' variant='secondary' onClick={stopMmw} disabled={stopping}>
                {stopping ? <Loader2 className='size-3.5 animate-spin' /> : null}
                {stopping ? '处理中…' : '尝试自动停服'}
              </Button>
            )}
          </div>
          <p className='text-xs text-muted-foreground'>
            妙妙屋自身没有"停止自己"的 API。两个选择:
          </p>
          <ul className='ml-4 list-disc text-xs text-muted-foreground'>
            <li>SSH 到 mmw 服务器手工 <code className='bg-muted px-1 py-0.5 rounded'>systemctl stop mmw</code></li>
            <li>或先继续向下走(导入时主控会再次告知如未停服可能数据不一致)</li>
          </ul>
        </div>
      )}

      <div className='flex justify-end pt-2'>
        <Button onClick={onNext} disabled={!result}>
          继续导入 <ArrowRight className='ml-2 size-4' />
        </Button>
      </div>
    </div>
  )
}

function ManualBackupSteps({ onNext }: { onNext: () => void }) {
  const ts = useMemo(() => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19), [])
  const backupCmd = `cp /etc/mmw/mmw.db /etc/mmw/mmw.db.before-mmwx-${ts}`
  const stopCmd = `systemctl stop mmw && systemctl disable mmw`
  const xrayBackupCmd = `cp /usr/local/etc/xray/config.json /usr/local/etc/xray/config.json.before-mmwx-${ts}`

  return (
    <div className='space-y-3'>
      <CommandBlock
        label='1. 备份 mmw 数据库'
        hint='路径默认 /etc/mmw/mmw.db,如果你装在别处请改路径'
        cmd={backupCmd}
      />
      <CommandBlock
        label='2. 备份每个 xray 节点服务器的 xray config(在节点机器上执行)'
        hint='迁移期间不动 xray 配置,但备份是稳妥做法'
        cmd={xrayBackupCmd}
      />
      <CommandBlock
        label='3. 停止并禁用 mmw 服务'
        hint='mmw 二进制不删,如需回滚:systemctl enable mmw && systemctl start mmw'
        cmd={stopCmd}
      />
      <Alert>
        <Terminal className='h-4 w-4' />
        <AlertTitle>验证 mmw 已停止</AlertTitle>
        <AlertDescription className='font-mono text-xs mt-1'>
          systemctl status mmw <span className='text-muted-foreground'># 应显示 inactive (dead)</span>
        </AlertDescription>
      </Alert>
      <div className='flex justify-end pt-2'>
        <Button onClick={onNext}>
          已完成,下一步 <ArrowRight className='ml-2 size-4' />
        </Button>
      </div>
    </div>
  )
}

/* -------------------- Step 3: Import mmw.db -------------------- */

type ImportReport = {
  users: number
  user_tokens: number
  nodes: number
  subscribe_files: number
  user_subscriptions: number
  user_settings: number
  templates: number
  custom_rules: number
  override_scripts: number
  external_subscriptions: number
  warnings?: string[]
}

type ImportResp = {
  success: boolean
  report: ImportReport
  owned_by_admin: string
  subscribes_copied: number
  subscribes_skipped: string[]
}

function Step3ImportDB({ onBack, onNext, autoBackup }: { onBack: () => void; onNext: () => void; autoBackup: AutoBackup }) {
  // 上一步已经自动拉取过 → 默认走 'auto' 源,无需再上传 / 填路径
  const initialMode: 'auto' | 'upload' | 'path' = autoBackup ? 'auto' : 'upload'
  const [mode, setMode] = useState<typeof initialMode>(initialMode)
  const [file, setFile] = useState<File | null>(null)
  const [dbPath, setDbPath] = useState('/etc/mmw/mmw.db')
  const [importing, setImporting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [report, setReport] = useState<ImportResp | null>(null)
  // 上传完得到的本地路径(db + subscribes),复用 AutoBackup 类型
  const [uploaded, setUploaded] = useState<AutoBackup>(null)

  const doUpload = async () => {
    if (!file) {
      toast.error('请先选择妙妙屋备份 zip 文件')
      return
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast.error('请上传妙妙屋后台导出的 .zip 备份(含 data/ 和 subscribes/)')
      return
    }
    setUploading(true)
    try {
      const form = new FormData()
      form.append('backup', file)
      const resp = await api.post('/api/admin/migrate/upload-mmw-backup', form, {
        timeout: 5 * 60 * 1000,
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const d = resp.data as AutoBackup
      setUploaded(d)
      toast.success(`上传成功 (${(d!.size_bytes / 1024 / 1024).toFixed(1)} MB, 订阅文件 ${d!.subscribe_count} 个)`)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || e?.message || '上传失败')
    } finally {
      setUploading(false)
    }
  }

  const doImport = async () => {
    let dbPathToImport = ''
    let subsDir = ''
    if (mode === 'auto') {
      if (!autoBackup?.db_path) {
        toast.error('未找到上一步拉取的备份,请返回 Step 2 重试')
        return
      }
      dbPathToImport = autoBackup.db_path
      subsDir = autoBackup.subscribes_dir || ''
    } else if (mode === 'upload') {
      if (!uploaded?.db_path) {
        toast.error('请先点"上传 + 解压"完成上传')
        return
      }
      dbPathToImport = uploaded.db_path
      subsDir = uploaded.subscribes_dir || ''
    } else {
      dbPathToImport = dbPath.trim()
      if (!dbPathToImport) {
        toast.error('请填写 mmw.db 路径')
        return
      }
    }
    setImporting(true)
    try {
      const resp = await api.post(
        '/api/admin/migrate/import-mmw',
        { db_path: dbPathToImport, subscribes_dir: subsDir },
        { timeout: 5 * 60 * 1000 },
      )
      const data = resp.data as ImportResp
      setReport(data)
      toast.success(`导入成功(用户 ${data.report.users} · 节点 ${data.report.nodes} · 订阅文件复制 ${data.subscribes_copied})`)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || e?.message || '导入失败')
    } finally {
      setImporting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>导入妙妙屋数据库</CardTitle>
        <CardDescription>
          上传或指定 mmw.db 路径,主控将读取数据并跑迁移。这一步是<strong>幂等</strong>的,失败可重试。
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='flex items-center gap-2 text-sm flex-wrap'>
          {autoBackup && (
            <Button
              variant={mode === 'auto' ? 'default' : 'outline'}
              size='sm'
              onClick={() => setMode('auto')}
            >
              <CheckCircle2 className='mr-2 size-4' />使用上一步拉取的备份
            </Button>
          )}
          <Button
            variant={mode === 'upload' ? 'default' : 'outline'}
            size='sm'
            onClick={() => setMode('upload')}
          >
            <Upload className='mr-2 size-4' />上传文件
          </Button>
          <Button
            variant={mode === 'path' ? 'default' : 'outline'}
            size='sm'
            onClick={() => setMode('path')}
          >
            <Terminal className='mr-2 size-4' />指定服务器路径
          </Button>
        </div>

        {mode === 'auto' && autoBackup ? (
          <Alert>
            <Database className='h-4 w-4' />
            <AlertTitle>来源:上一步自动拉取</AlertTitle>
            <AlertDescription className='mt-2 text-xs space-y-1'>
              <div>db 路径:<code className='bg-muted px-1 py-0.5 rounded'>{autoBackup.db_path}</code></div>
              <div>数据库:{(autoBackup.db_size_bytes / 1024 / 1024).toFixed(2)} MB · 订阅文件:{autoBackup.subscribe_count} 个</div>
              <div className='text-muted-foreground'>点"开始导入"即可,无需再上传文件。</div>
            </AlertDescription>
          </Alert>
        ) : mode === 'upload' ? (
          <div className='space-y-2'>
            <Label>选择妙妙屋备份(.zip)</Label>
            <p className='text-[11px] text-muted-foreground'>
              在妙妙屋后台「设置 → 备份」点击「下载备份」拿到的 .zip 文件,内含 <code className='bg-muted px-1 py-0.5 rounded'>data/mmw.db</code> 和 <code className='bg-muted px-1 py-0.5 rounded'>subscribes/</code>
            </p>
            <div className='flex items-center gap-2'>
              <Input
                type='file'
                accept='.zip'
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setUploaded(null) }}
                disabled={uploading || Boolean(uploaded)}
                className='flex-1'
              />
              {!uploaded && (
                <Button onClick={doUpload} disabled={uploading || !file} size='sm'>
                  {uploading ? <><Loader2 className='mr-2 size-4 animate-spin' />上传中…</> : <><Upload className='mr-2 size-4' />上传 + 解压</>}
                </Button>
              )}
            </div>
            {file && !uploaded && (
              <p className='text-xs text-muted-foreground'>已选:{file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</p>
            )}
            {uploaded && (
              <Alert>
                <CheckCircle2 className='h-4 w-4' />
                <AlertTitle>上传成功</AlertTitle>
                <AlertDescription className='text-xs mt-1 space-y-1'>
                  <div>db:<code className='bg-muted px-1 py-0.5 rounded'>{uploaded.db_path}</code> ({(uploaded.db_size_bytes / 1024 / 1024).toFixed(2)} MB)</div>
                  <div>subscribes 文件:{uploaded.subscribe_count} 个</div>
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <div className='space-y-2'>
            <Label>mmw.db 路径(主控服务器本地路径)</Label>
            <Input
              value={dbPath}
              onChange={(e) => setDbPath(e.target.value)}
              placeholder='/etc/mmw/mmw.db'
              className='font-mono text-sm'
            />
            <p className='text-xs text-muted-foreground'>
              主控会以读模式打开该文件;若主控和 mmw 不在同一台机器,请用"上传文件"模式
            </p>
          </div>
        )}

        <Alert>
          <Database className='h-4 w-4' />
          <AlertTitle>迁移会做什么</AlertTitle>
          <AlertDescription>
            <ul className='ml-4 mt-2 space-y-1 list-disc text-xs'>
              <li>读 mmw <code className='bg-muted px-1 py-0.5 rounded'>users / nodes / subscribe_files / packages / user_subscriptions / templates / custom_rules / override_scripts</code> 数据</li>
              <li>按 mmwx schema 写入主控数据库(自动 ALTER TABLE 补齐缺失列)</li>
              <li>把 mmw 来源节点的 <code className='bg-muted px-1 py-0.5 rounded'>tag</code> 改为 <code className='bg-muted px-1 py-0.5 rounded'>'妙妙屋迁移'</code>,便于识别</li>
              <li>把 mmw 用户的多绑定订阅合并为单一套餐 <code className='bg-muted px-1 py-0.5 rounded'>{'<username>-merged'}</code></li>
              <li><strong>不动</strong> xray 配置 / 远程服务器 / inbound clients</li>
            </ul>
          </AlertDescription>
        </Alert>

        {report && (
          <Alert>
            <CheckCircle2 className='h-4 w-4' />
            <AlertTitle>导入完成</AlertTitle>
            <AlertDescription className='mt-2 space-y-2 text-xs'>
              <div className='grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5'>
                <ReportItem label='用户' value={report.report.users} />
                <ReportItem label='用户短码/Token' value={report.report.user_tokens} />
                <ReportItem label='节点' value={report.report.nodes} />
                <ReportItem label='订阅文件' value={report.report.subscribe_files} />
                <ReportItem label='用户-订阅' value={report.report.user_subscriptions} />
                <ReportItem label='用户设置' value={report.report.user_settings} />
                <ReportItem label='模板' value={report.report.templates} />
                <ReportItem label='覆写规则' value={report.report.custom_rules} />
                <ReportItem label='覆写脚本' value={report.report.override_scripts} />
                <ReportItem label='外部订阅' value={report.report.external_subscriptions} />
                <ReportItem label='订阅文件复制' value={report.subscribes_copied} />
              </div>
              <div className='rounded border bg-muted/30 p-2 space-y-0.5'>
                <div>订阅文件 / 模板的归属设为管理员:<code className='bg-muted px-1 py-0.5 rounded'>{report.owned_by_admin}</code></div>
                <div className='text-muted-foreground'>数字为<strong>新增</strong>行数;已存在的同名 / 同 id 行按 INSERT OR IGNORE 跳过,不会覆盖。</div>
              </div>
              {report.subscribes_skipped && report.subscribes_skipped.length > 0 && (
                <div className='rounded border bg-muted/30 p-2'>
                  <div className='font-medium'>跳过的订阅文件(同名已存在):</div>
                  <div className='text-muted-foreground font-mono'>{report.subscribes_skipped.join(', ')}</div>
                </div>
              )}
              {report.report.warnings && report.report.warnings.length > 0 && (
                <div className='rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 p-2 space-y-1'>
                  <div className='font-medium text-amber-700 dark:text-amber-300'>警告</div>
                  {report.report.warnings.map((w, i) => (
                    <div key={i} className='text-amber-700 dark:text-amber-300'>{w}</div>
                  ))}
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardContent className='flex justify-between pt-0'>
        <Button variant='outline' onClick={onBack}>上一步</Button>
        <div className='flex gap-2'>
          <Button variant='secondary' onClick={doImport} disabled={importing}>
            {importing ? (
              <><Loader2 className='mr-2 size-4 animate-spin' />导入中…</>
            ) : (
              <><Database className='mr-2 size-4' />开始导入</>
            )}
          </Button>
          <Button onClick={onNext} disabled={!report}>
            下一步 <ArrowRight className='ml-2 size-4' />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ReportItem({ label, value }: { label: string; value: number }) {
  return (
    <div className='rounded border bg-background p-2'>
      <div className='text-muted-foreground text-[10px]'>{label}</div>
      <div className='font-semibold'>{value}</div>
    </div>
  )
}

/* -------------------- Step 4: Server inventory + agent install -------------------- */

type DistinctServer = {
  address: string
  node_count: number
  ports: number[]
  protocols: string[]
  existing_server: boolean
  existing_server_id?: number
  sample_node_name: string
}

type TakeoverResp = {
  success: boolean
  servers_scanned: number
  results: Array<{
    server_id: number
    server_name: string
    detected: boolean
    config_path?: string
    conf_dir?: string
    merged_files: number
    backup_dir?: string
    restarted: boolean
    message: string
    error?: string
  }>
}

type AdminSubaccount = {
  server_id: number
  server_name: string
  inbound_tag: string
  email: string
  was_new: boolean
}

type PatchClientEmailsResp = {
  success: boolean
  owned_by_admin: string
  servers_scanned: number
  inbounds_total: number
  clients_patched: { server_id: number; server_name: string; inbound_tag: string; old_email: string; new_email: string }[]
  admin_subaccounts_linked: AdminSubaccount[]
  ss2022_inbounds: { server_id: number; server_name: string; inbound_tag: string; method: string }[]
  server_errors?: string[]
}

function Step4Claim({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [loading, setLoading] = useState(false)
  const [servers, setServers] = useState<DistinctServer[]>([])
  const [note, setNote] = useState('')
  const [patching, setPatching] = useState(false)
  const [patchResult, setPatchResult] = useState<PatchClientEmailsResp | null>(null)
  const [takingOver, setTakingOver] = useState(false)
  const [takeoverResult, setTakeoverResult] = useState<TakeoverResp | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const resp = await api.get('/api/admin/migrate/distinct-node-servers')
      const d = resp.data as { servers: DistinctServer[]; note: string }
      setServers(d.servers || [])
      setNote(d.note || '')
    } catch (e: any) {
      toast.error(e?.response?.data?.error || e?.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }

  const takeoverXray = async () => {
    setTakingOver(true)
    try {
      const resp = await api.post('/api/admin/migrate/takeover-external-xray', {}, { timeout: 3 * 60 * 1000 })
      const raw = resp.data as TakeoverResp
      const d: TakeoverResp = { ...raw, results: raw.results ?? [] }
      setTakeoverResult(d)
      const detected = d.results.filter((r) => r.detected).length
      toast.success(`扫描 ${d.servers_scanned} 个服务器,${detected} 个发现外置 xray 并已合并接管`)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || e?.message || '接管失败')
    } finally {
      setTakingOver(false)
    }
  }

  const patchEmails = async () => {
    setPatching(true)
    try {
      const resp = await api.post('/api/admin/migrate/patch-client-emails', {}, { timeout: 2 * 60 * 1000 })
      const raw = resp.data as PatchClientEmailsResp
      // 后端 nil slice 会序列化成 null,这里兜底成空数组,下游 .length 等才安全
      const d: PatchClientEmailsResp = {
        ...raw,
        clients_patched: raw.clients_patched ?? [],
        admin_subaccounts_linked: raw.admin_subaccounts_linked ?? [],
        ss2022_inbounds: raw.ss2022_inbounds ?? [],
        server_errors: raw.server_errors ?? [],
      }
      setPatchResult(d)
      const newAdminLinks = d.admin_subaccounts_linked.filter((a) => a.was_new).length
      toast.success(`已扫描 ${d.servers_scanned} 个服务器,补 email ${d.clients_patched.length} 个 · 绑定到管理员 ${newAdminLinks} 个`)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || e?.message || '扫描失败')
    } finally {
      setPatching(false)
    }
  }

  // 进入步骤时自动加载一次
  useEffect(() => { void load() }, [])

  const totalNodes = servers.reduce((s, x) => s + x.node_count, 0)
  const linkedCount = servers.filter(s => s.existing_server).length

  return (
    <Card>
      <CardHeader>
        <CardTitle>添加远程服务器并安装 Agent</CardTitle>
        <CardDescription>
          妙妙屋只是个 Clash 订阅工具,没有"远程服务器 / xray 入站"的概念。
          要让从妙妙屋导入的节点变成<strong>受管节点</strong>(能查流量 / 限速 / 路由出站),
          需要为每个节点指向的服务器地址装上 mmw-agent;agent 接入后,主控会自动扫描其 xray inbound 并与节点凭据匹配。
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 text-sm'>
        <div className='flex items-center gap-3 rounded-md border bg-muted/30 p-3 text-xs'>
          <Database className='size-4 shrink-0' />
          <div className='flex-1 min-w-0'>
            <div>
              扫描到 <strong>{servers.length}</strong> 个去重 server 地址,共 <strong>{totalNodes}</strong> 个节点;
              其中 <strong>{linkedCount}</strong> 个已在 mmwx 服务管理里存在。
            </div>
            {note && <div className='text-muted-foreground mt-1'>{note}</div>}
          </div>
          <Button size='sm' variant='outline' onClick={load} disabled={loading}>
            {loading ? <Loader2 className='size-3.5 animate-spin' /> : '刷新'}
          </Button>
        </div>

        {servers.length === 0 && !loading ? (
          <Alert>
            <CheckCircle2 className='h-4 w-4' />
            <AlertTitle>没有待处理的服务器</AlertTitle>
            <AlertDescription>
              所有节点都已关联到 mmwx 的远程服务器(或导入的节点为 0)。可以直接跳到下一步。
            </AlertDescription>
          </Alert>
        ) : (
          <div className='space-y-2 max-h-[420px] overflow-y-auto'>
            {servers.map((s) => (
              <ServerRow key={s.address} server={s} onAdded={load} />
            ))}
          </div>
        )}

        {/* 接管外置 xray(合并 -confdir 进单文件) */}
        <div className='rounded-md border p-3 space-y-2'>
          <div className='flex items-center justify-between gap-2 flex-wrap'>
            <div>
              <div className='text-sm font-medium'>① 接管外置 xray(合并多片配置)</div>
              <p className='text-xs text-muted-foreground'>
                妙妙屋时代的 xray 一般通过 <code className='bg-muted px-1 py-0.5 rounded'>-config FILE -confdir DIR</code> 多片启动。
                mmwx 主控只读写单一 config 文件,需要先合并。本操作会让每台已加入的 agent:
              </p>
              <ul className='text-xs text-muted-foreground ml-4 list-disc mt-1'>
                <li>探测正在跑的 xray + 解析 ExecStart 拿 <code className='bg-muted px-1 py-0.5 rounded'>-config / -confdir</code></li>
                <li>把 confdir 里所有 <code className='bg-muted px-1 py-0.5 rounded'>*.json</code> 按字母序合并进主 config</li>
                <li>把 confdir 内 *.json 备份到 <code className='bg-muted px-1 py-0.5 rounded'>.mmwx-bak-&lt;ts&gt;/</code> 子目录,防止 xray 重启又读旧片</li>
                <li>重启 xray</li>
              </ul>
            </div>
            <Button size='sm' onClick={takeoverXray} disabled={takingOver}>
              {takingOver ? <><Loader2 className='mr-2 size-4 animate-spin' />扫描中…</> : <><Terminal className='mr-2 size-4' />扫描并接管</>}
            </Button>
          </div>

          {takeoverResult && (
            <div className='space-y-2 pt-2 text-xs border-t'>
              <div className='grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2'>
                <ReportItem label='扫描服务器' value={takeoverResult.servers_scanned} />
                <ReportItem label='发现外置 xray' value={takeoverResult.results.filter(r => r.detected).length} />
                <ReportItem label='重启成功' value={takeoverResult.results.filter(r => r.restarted).length} />
              </div>
              <details className='rounded border bg-muted/30 p-2'>
                <summary className='cursor-pointer font-medium'>每台服务器详情</summary>
                <table className='mt-2 w-full text-[11px]'>
                  <thead className='text-muted-foreground'>
                    <tr>
                      <th className='text-left py-1 pr-2'>服务器</th>
                      <th className='text-left py-1 pr-2'>状态</th>
                      <th className='text-left py-1 pr-2'>config / confdir</th>
                      <th className='text-left py-1'>合并/重启</th>
                    </tr>
                  </thead>
                  <tbody>
                    {takeoverResult.results.map((r, i) => (
                      <tr key={i} className='border-t border-muted'>
                        <td className='py-1 pr-2'>{r.server_name}</td>
                        <td className='py-1 pr-2'>
                          {r.error ? <span className='text-destructive'>错误</span>
                            : r.detected ? <span className='text-primary'>已接管</span>
                            : <span className='text-muted-foreground'>未检测到外置</span>}
                        </td>
                        <td className='py-1 pr-2 font-mono'>
                          {r.config_path ? <div>{r.config_path}</div> : null}
                          {r.conf_dir ? <div className='text-muted-foreground'>{r.conf_dir}</div> : null}
                          {r.error ? <div className='text-destructive'>{r.error}</div> : null}
                        </td>
                        <td className='py-1'>{r.merged_files} 个 / {r.restarted ? '✓' : '✗'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          )}
        </div>

        {/* 扫描 + 补 client email */}
        <div className='rounded-md border p-3 space-y-2'>
          <div className='flex items-center justify-between gap-2 flex-wrap'>
            <div>
              <div className='text-sm font-medium'>② 扫描并补 xray client email</div>
              <p className='text-xs text-muted-foreground'>
                Agent 接入后,对所有 inbound 的 client 检查 <code className='bg-muted px-1 py-0.5 rounded'>email</code> 字段;
                没填的补成管理员用户名,后续 mmwx 才能按 email 做流量统计 / routing 限定。
              </p>
            </div>
            <Button size='sm' onClick={patchEmails} disabled={patching}>
              {patching ? <><Loader2 className='mr-2 size-4 animate-spin' />扫描中…</> : <><ShieldCheck className='mr-2 size-4' />开始扫描 + 补 email</>}
            </Button>
          </div>

          {patchResult && (
            <div className='space-y-2 pt-2 text-xs border-t'>
              <div className='grid grid-cols-2 sm:grid-cols-5 gap-2 mt-2'>
                <ReportItem label='扫描服务器' value={patchResult.servers_scanned} />
                <ReportItem label='Inbound 总数' value={patchResult.inbounds_total} />
                <ReportItem label='补 email Client' value={patchResult.clients_patched.length} />
                <ReportItem label='绑管理员(新)' value={patchResult.admin_subaccounts_linked.filter(a => a.was_new).length} />
                <ReportItem label='SS2022 Inbound' value={patchResult.ss2022_inbounds.length} />
              </div>

              {patchResult.clients_patched.length > 0 && (
                <details className='rounded border bg-muted/30 p-2'>
                  <summary className='cursor-pointer font-medium'>补了 email 的 client 列表 ({patchResult.clients_patched.length})</summary>
                  <table className='mt-2 w-full text-[11px]'>
                    <thead className='text-muted-foreground'>
                      <tr>
                        <th className='text-left py-1 pr-2'>服务器</th>
                        <th className='text-left py-1 pr-2'>Inbound Tag</th>
                        <th className='text-left py-1'>新 email</th>
                      </tr>
                    </thead>
                    <tbody>
                      {patchResult.clients_patched.map((c, i) => (
                        <tr key={i} className='border-t border-muted'>
                          <td className='py-1 pr-2'>{c.server_name}</td>
                          <td className='py-1 pr-2 font-mono'>{c.inbound_tag}</td>
                          <td className='py-1 font-mono'>{c.new_email}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}

              {patchResult.admin_subaccounts_linked.length > 0 && (
                <details className='rounded border bg-muted/30 p-2'>
                  <summary className='cursor-pointer font-medium'>
                    绑定到管理员的 client 列表 ({patchResult.admin_subaccounts_linked.length} 个, 其中新增 {patchResult.admin_subaccounts_linked.filter(a => a.was_new).length})
                  </summary>
                  <p className='text-[11px] text-muted-foreground mt-1'>
                    所有 inbound 上有 email 的 client(无论原本就有还是这次刚补的)都登记到 <code className='bg-muted px-1 py-0.5 rounded'>user_inbound_configs</code> 表归属 <code className='bg-muted px-1 py-0.5 rounded'>{patchResult.owned_by_admin}</code>。
                    这样这些 client 的流量统计、限速、节点测速等高级能力都能正常工作。
                  </p>
                  <table className='mt-2 w-full text-[11px]'>
                    <thead className='text-muted-foreground'>
                      <tr>
                        <th className='text-left py-1 pr-2'>服务器</th>
                        <th className='text-left py-1 pr-2'>Inbound Tag</th>
                        <th className='text-left py-1 pr-2'>email</th>
                        <th className='text-left py-1'>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {patchResult.admin_subaccounts_linked.map((a, i) => (
                        <tr key={i} className='border-t border-muted'>
                          <td className='py-1 pr-2'>{a.server_name}</td>
                          <td className='py-1 pr-2 font-mono'>{a.inbound_tag}</td>
                          <td className='py-1 pr-2 font-mono'>{a.email}</td>
                          <td className='py-1'>{a.was_new ? <span className='text-primary'>新增</span> : <span className='text-muted-foreground'>已存在</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}

              {patchResult.ss2022_inbounds.length > 0 && (
                <div className='rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 p-2 space-y-1'>
                  <div className='font-medium text-amber-800 dark:text-amber-200'>
                    ⚠ {patchResult.ss2022_inbounds.length} 个 SS2022 inbound 已更新,客户端订阅需重新拉取
                  </div>
                  <p className='text-amber-700 dark:text-amber-300'>
                    SS2022 协议 (<code className='bg-amber-100 dark:bg-amber-900 px-1 rounded'>2022-*</code> 加密) 的 multi-user 模式下,
                    客户端密码格式为 <code className='bg-amber-100 dark:bg-amber-900 px-1 rounded'>{'<inbound_password>:<user_password>'}</code> 拼接。
                    给 client 加 email 后,主控生成的订阅会按拼接形式输出,旧订阅密码会失效 → <strong>必须重新拉一次订阅</strong>。
                  </p>
                  <details className='text-amber-700 dark:text-amber-300'>
                    <summary className='cursor-pointer'>受影响 inbound 列表</summary>
                    <ul className='mt-1 ml-4 list-disc'>
                      {patchResult.ss2022_inbounds.map((s, i) => (
                        <li key={i} className='font-mono'>{s.server_name} → {s.inbound_tag} ({s.method})</li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}

              {patchResult.server_errors && patchResult.server_errors.length > 0 && (
                <div className='rounded border border-destructive/30 bg-destructive/5 p-2 space-y-1'>
                  <div className='font-medium text-destructive'>处理出错的服务器</div>
                  <ul className='ml-4 list-disc text-destructive'>
                    {patchResult.server_errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <Alert>
          <FileWarning className='h-4 w-4' />
          <AlertTitle>这一步可以稍后做</AlertTitle>
          <AlertDescription className='text-xs'>
            不做这一步:导入的节点仍能在订阅里正常使用(uuid / 密码全保留,客户端无感)。
            做这一步:让节点流量统计、限速、路由出站等高级能力生效。
            随时可以从「服务管理 → 添加远程服务器」继续。
          </AlertDescription>
        </Alert>
      </CardContent>
      <CardContent className='flex justify-between pt-0'>
        <Button variant='outline' onClick={onBack}>上一步</Button>
        <Button onClick={onNext}>
          下一步 <ArrowRight className='ml-2 size-4' />
        </Button>
      </CardContent>
    </Card>
  )
}

function ServerRow({ server, onAdded }: { server: DistinctServer; onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className='rounded-md border p-3 space-y-2'>
        <div className='flex items-center justify-between gap-2 flex-wrap'>
          <div className='flex items-center gap-2 min-w-0'>
            <Database className='size-4 shrink-0 text-muted-foreground' />
            <span className='font-mono text-sm truncate'>{server.address}</span>
            {server.existing_server ? (
              <Badge variant='outline' className='text-[10px] border-primary text-primary'>已添加</Badge>
            ) : (
              <Badge variant='outline' className='text-[10px]'>待添加</Badge>
            )}
          </div>
          <div className='flex items-center gap-2'>
            {server.existing_server ? (
              <Button asChild size='sm' variant='outline'>
                <Link to='/xray-servers'>查看</Link>
              </Button>
            ) : (
              <Button size='sm' onClick={() => setOpen(true)}>
                去添加 <ArrowRight className='ml-1 size-3' />
              </Button>
            )}
          </div>
        </div>
        <div className='flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground'>
          <span>节点数:<strong className='text-foreground'>{server.node_count}</strong></span>
          {server.ports.length > 0 && (
            <span>端口:{server.ports.sort((a, b) => a - b).join(' / ')}</span>
          )}
          {server.protocols.length > 0 && (
            <span>协议:{server.protocols.join(' / ')}</span>
          )}
          {server.sample_node_name && (
            <span className='truncate'>样例节点:{server.sample_node_name}</span>
          )}
        </div>
      </div>
      <AddServerDialog
        open={open}
        onOpenChange={setOpen}
        defaultAddress={server.address}
        defaultName={server.sample_node_name || server.address}
        onAdded={() => { setOpen(false); onAdded() }}
      />
    </>
  )
}

/* -------------------- AddServerDialog -------------------- */

type CreateRemoteResp = {
  success: boolean
  server?: { id: number; name: string; token: string; pull_token?: string }
  install_command?: string
  message?: string
}

function AddServerDialog({
  open,
  onOpenChange,
  defaultAddress,
  defaultName,
  onAdded,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  defaultAddress: string
  defaultName: string
  onAdded: () => void
}) {
  const [name, setName] = useState(defaultName)
  const [address, setAddress] = useState(defaultAddress)
  const [trafficLimitGB, setTrafficLimitGB] = useState('')
  const [trafficUsedGB, setTrafficUsedGB] = useState('')
  const [resetDay, setResetDay] = useState('1')
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<CreateRemoteResp | null>(null)

  // 重置 dialog state(每次打开恢复初值)
  useEffect(() => {
    if (open) {
      setName(defaultName)
      setAddress(defaultAddress)
      setTrafficLimitGB('')
      setTrafficUsedGB('')
      setResetDay('1')
      setResult(null)
      setCreating(false)
    }
  }, [open, defaultName, defaultAddress])

  const submit = async () => {
    if (!name.trim() || !address.trim()) {
      toast.error('服务器名称 / 地址必填')
      return
    }
    const limitBytes = Math.max(0, Math.floor(parseFloat(trafficLimitGB || '0') * 1024 ** 3))
    const usedBytes = Math.max(0, Math.floor(parseFloat(trafficUsedGB || '0') * 1024 ** 3))
    const day = Math.min(31, Math.max(1, parseInt(resetDay, 10) || 1))
    setCreating(true)
    try {
      const resp = await api.post('/api/admin/remote-servers/create', {
        name: name.trim(),
        pull_address: address.trim(),
        traffic_limit: limitBytes || undefined,
        traffic_used_offset: usedBytes || undefined,
        traffic_reset_day: day,
        connection_mode: 'auto',
        // 迁移场景下默认用 embedded xray:agent 启动时会自动接管外置 xray —
        // 把 /etc/xray/config.json + confdir/* 合并写到 mmwx 标准路径 /usr/local/etc/xray/config.json,
        // 再用 embedded xray 启动。无需后续手工"接管"操作。
        xray_mode: 'embedded',
      })
      const data = resp.data as CreateRemoteResp
      if (!data.success) {
        toast.error(data.message || '创建失败')
        setCreating(false)
        return
      }
      setResult(data)
      toast.success('服务器已创建,请按下方命令在服务器上安装 agent')
    } catch (e: any) {
      toast.error(e?.response?.data?.error || e?.message || '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('已复制')
    } catch {
      toast.error('复制失败,请手动选择')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>添加远程服务器(内置 xray 模式)</DialogTitle>
          <DialogDescription>
            服务器地址已自动填入妙妙屋节点的地址。创建后系统生成 agent 安装命令,在服务器执行后:
            <strong className='text-foreground'> agent 会自动接管外置 xray</strong> —— 把 <code className='bg-muted px-1 py-0.5 rounded text-[10px]'>/etc/xray/config.json</code> + <code className='bg-muted px-1 py-0.5 rounded text-[10px]'>confdir/*.json</code> 合并到 <code className='bg-muted px-1 py-0.5 rounded text-[10px]'>/usr/local/etc/xray/config.json</code>,停外置 xray 服务并用内置 xray 启动。原配置自动归档备份。
          </DialogDescription>
        </DialogHeader>

        {!result ? (
          <div className='space-y-4 py-2'>
            <div className='grid gap-3 sm:grid-cols-2'>
              <div className='space-y-1 sm:col-span-2'>
                <Label className='text-xs'>服务器名称</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
                <p className='text-[10px] text-muted-foreground'>默认取样例节点名;建议改成易记的标识(如「香港 JINX1」)</p>
              </div>
              <div className='space-y-1 sm:col-span-2'>
                <Label className='text-xs'>服务器地址</Label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} className='font-mono' />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>流量上限(GB)</Label>
                <Input
                  type='number' step='0.01' min='0'
                  value={trafficLimitGB} onChange={(e) => setTrafficLimitGB(e.target.value)}
                  placeholder='留空 = 不限'
                />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>已用流量(GB)</Label>
                <Input
                  type='number' step='0.01' min='0'
                  value={trafficUsedGB} onChange={(e) => setTrafficUsedGB(e.target.value)}
                  placeholder='可填上月已用量,用作起算偏移'
                />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>每月重置日</Label>
                <Input
                  type='number' min='1' max='31'
                  value={resetDay} onChange={(e) => setResetDay(e.target.value)}
                  placeholder='1'
                />
              </div>
            </div>
          </div>
        ) : (
          <div className='space-y-3 py-2'>
            <Alert>
              <CheckCircle2 className='h-4 w-4' />
              <AlertTitle>服务器已创建</AlertTitle>
              <AlertDescription className='text-xs mt-1'>
                ID: {result.server?.id} · 名称:{result.server?.name}
              </AlertDescription>
            </Alert>
            <div className='space-y-1'>
              <Label className='text-xs flex items-center justify-between'>
                <span>Agent 安装命令(在服务器上以 root 执行)</span>
                <Button variant='ghost' size='sm' className='h-6' onClick={() => copy(result.install_command || '')}>
                  <Copy className='mr-1 size-3' />复制
                </Button>
              </Label>
              <pre className='rounded border bg-muted/50 p-3 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap break-all'>
                {result.install_command || '(未返回安装命令)'}
              </pre>
            </div>
            {result.server?.token && (
              <div className='space-y-1'>
                <Label className='text-xs flex items-center justify-between'>
                  <span>Agent 认证 Token</span>
                  <Button variant='ghost' size='sm' className='h-6' onClick={() => copy(result.server!.token)}>
                    <Copy className='mr-1 size-3' />复制
                  </Button>
                </Label>
                <pre className='rounded border bg-muted/50 p-2 text-[11px] font-mono break-all'>{result.server.token}</pre>
              </div>
            )}
            <Alert>
              <Terminal className='h-4 w-4' />
              <AlertTitle>下一步</AlertTitle>
              <AlertDescription className='text-xs'>
                Agent 接入后,主控会自动扫描该服务器的 xray 入站。已导入的妙妙屋节点会按凭据匹配自动绑定为受管节点(无需手工操作)。
              </AlertDescription>
            </Alert>
          </div>
        )}

        <DialogFooter>
          {!result ? (
            <>
              <Button variant='outline' onClick={() => onOpenChange(false)} disabled={creating}>取消</Button>
              <Button onClick={submit} disabled={creating}>
                {creating ? <><Loader2 className='mr-2 size-4 animate-spin' />创建中…</> : '生成 Token + 安装命令'}
              </Button>
            </>
          ) : (
            <Button onClick={onAdded}>完成,关闭</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------- Step 5: Verify & finish -------------------- */

function Step5Verify({ onBack }: { onBack: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>验证并完成</CardTitle>
        <CardDescription>
          确认核心能力可用,然后回到正常的妙妙屋X 工作流。
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 text-sm'>
        <ChecklistItem
          title='主控访问正常'
          desc='你能看到这一页,说明 https://your-domain 已经指向 mmwx,nginx + SSL 都没问题'
          done
        />
        <ChecklistItem
          title='节点列表恢复'
          desc='去「节点管理」页面,应看到原 mmw 节点(tag 显示「妙妙屋迁移」)'
          link='/nodes'
        />
        <ChecklistItem
          title='用户与套餐恢复'
          desc='去「用户管理」/「套餐管理」,应看到原 mmw 用户及自动生成的套餐'
          link='/users'
        />
        <ChecklistItem
          title='抽测一个客户端订阅'
          desc='复制订阅 URL 在 Clash/Shadowrocket 中刷新,应能正常拉到节点'
        />
        <ChecklistItem
          title='Agent 版本检查'
          desc='所有 mmw 节点服务器已安装 mmw-agent 0.1.x+(支持用户路由出站功能)'
          link='/xray-servers'
        />

        <Separator />

        <Alert>
          <ShieldCheck className='h-4 w-4' />
          <AlertTitle>回滚预案(若发现问题)</AlertTitle>
          <AlertDescription>
            <ol className='ml-4 mt-2 space-y-1 list-decimal text-xs'>
              <li><code className='bg-muted px-1 py-0.5 rounded'>systemctl stop mmwx</code></li>
              <li><code className='bg-muted px-1 py-0.5 rounded'>systemctl start mmw</code></li>
              <li>mmw 数据库 / xray 配置全程未被修改,客户端立即恢复</li>
              <li>把问题截图 / 日志反馈给我们再重新尝试迁移</li>
            </ol>
          </AlertDescription>
        </Alert>
      </CardContent>
      <CardContent className='flex justify-between pt-0'>
        <Button variant='outline' onClick={onBack}>上一步</Button>
        <Button asChild>
          <Link to='/'>完成,回到首页</Link>
        </Button>
      </CardContent>
    </Card>
  )
}

function ChecklistItem({ title, desc, done, link }: { title: string; desc: string; done?: boolean; link?: string }) {
  return (
    <div className='flex items-start gap-3 rounded-md border p-3'>
      {done ? (
        <CheckCircle2 className='size-5 shrink-0 text-primary mt-0.5' />
      ) : (
        <Circle className='size-5 shrink-0 text-muted-foreground mt-0.5' />
      )}
      <div className='flex-1 min-w-0'>
        <div className='text-sm font-medium'>{title}</div>
        <div className='text-xs text-muted-foreground mt-0.5'>{desc}</div>
      </div>
      {link && (
        <Button asChild size='sm' variant='ghost' className='shrink-0'>
          <Link to={link}>
            前往 <ArrowRight className='ml-1 size-3' />
          </Link>
        </Button>
      )}
    </div>
  )
}

/* -------------------- Reusable: CommandBlock -------------------- */

function CommandBlock({ label, hint, cmd }: { label: string; hint?: string; cmd: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd)
      toast.success('已复制')
    } catch {
      toast.error('复制失败,请手动选择')
    }
  }
  return (
    <div className='space-y-1'>
      <div className='flex items-center justify-between'>
        <Label className='text-sm'>{label}</Label>
        <Button variant='ghost' size='sm' className='h-7' onClick={copy}>
          <Copy className='mr-1 size-3.5' />复制
        </Button>
      </div>
      {hint && <p className='text-[11px] text-muted-foreground'>{hint}</p>}
      <pre className='rounded border bg-muted/40 p-3 text-xs font-mono overflow-x-auto'>{cmd}</pre>
    </div>
  )
}
