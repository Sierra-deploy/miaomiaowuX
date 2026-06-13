// VLESS WSS 入站预检:nginx 装了 + 有可用证书才走自动配置流程。
// 不满足两个条件之一时,弹出本 dialog 显示「手动配置」按钮 — 用户复制 nginx 配置模板,
// 自己 ssh 到服务器粘贴 + 配证书。
//
// 全部满足时:一打开就触发 onPass() 关 dialog,流程继续。
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, XCircle, Copy, AlertTriangle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

interface ServiceStatus {
  installed?: boolean
  running?: boolean
  version?: string
}
interface ServicesStatusResp {
  success?: boolean
  nginx?: ServiceStatus
  xray?: ServiceStatus
}
interface Certificate {
  id: number
  domain: string
  remote_server_id: number
  status: string
  auto_deploy?: boolean
}

interface WssPrecheckDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverId: number | null
  serverDomain?: string
  onPass: () => void
}

// nginx 手动配置模板,占位符用尖括号 + 中文 — 用户看得懂、ssh 上 sed/手改都方便
const NGINX_MANUAL_TEMPLATE = `server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name <您的域名>;

    ssl_certificate     <证书 .pem 路径,比如 /usr/local/nginx/cert/example.com.pem>;
    ssl_certificate_key <证书 .key 路径,比如 /usr/local/nginx/cert/example.com.key>;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;

    index index.html;
    root  /var/www/html;

    # 在 location 后填写 妙妙屋X 给入站生成的 ws 路径(如 /ws/abcd1234)
    location = </您的 ws 路径> {
        if ($http_upgrade != "websocket") { return 404; }
        proxy_pass         http://127.0.0.1:<xray 监听的本地端口>;
        proxy_redirect     off;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade            $http_upgrade;
        proxy_set_header   Connection         "upgrade";
        proxy_set_header   Host               $host;
        proxy_set_header   X-Real-IP          $remote_addr;
        proxy_set_header   X-Forwarded-For    $proxy_add_x_forwarded_for;
        proxy_read_timeout 5d;
    }
}
`

export function WssPrecheckDialog({
  open,
  onOpenChange,
  serverId,
  serverDomain,
  onPass,
}: WssPrecheckDialogProps) {
  const copy = useCopyToClipboard()
  const [showManual, setShowManual] = useState(false)

  const statusQ = useQuery({
    queryKey: ['services-status', serverId],
    queryFn: async () => {
      const res = await api.get<ServicesStatusResp>(
        `/api/admin/remote/services/status?server_id=${serverId}`,
      )
      return res.data
    },
    enabled: open && serverId != null,
    staleTime: 30_000,
  })

  const certsQ = useQuery({
    queryKey: ['certificates-valid-for-wss', serverId],
    queryFn: async () => {
      const res = await api.get('/api/admin/certificates/valid')
      const list = (res.data?.certificates ?? []) as Certificate[]
      // 该 server 可用的证书 = per-server 直绑 + 全局 auto_deploy(会被推到 agent)。
      // 后端 syncWSSNginx 的查找顺序也是这样兜底,前后端一致。
      return list.filter((c) => c.remote_server_id === serverId || (c.remote_server_id === 0 && c.auto_deploy))
    },
    enabled: open && serverId != null,
  })

  const nginxOk = Boolean(statusQ.data?.nginx?.installed && statusQ.data?.nginx?.running)
  const hasCert = (certsQ.data?.length ?? 0) > 0
  const loading = statusQ.isLoading || certsQ.isLoading

  // 全部就绪:一打开就直接 onPass(),不阻断用户
  useEffect(() => {
    if (!open) {
      setShowManual(false)
      return
    }
    if (loading) return
    if (nginxOk && hasCert) {
      onPass()
    }
  }, [open, loading, nginxOk, hasCert, onPass])

  const handleCopyManual = async () => {
    const filled = NGINX_MANUAL_TEMPLATE.replace(
      '<您的域名>',
      serverDomain || '<您的域名>',
    )
    await copy(filled, {
      success: '已复制 nginx 配置到剪贴板',
      failure: '复制失败,请手动选择文本复制',
    })
  }

  // 渲染条件:loading 阶段不显示分支内容,避免闪
  const showNginxMissing = !loading && !nginxOk
  const showCertMissing = !loading && nginxOk && !hasCert

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <AlertTriangle className='h-5 w-5 text-amber-500' />
            VLESS WSS 入站环境检查
          </DialogTitle>
          <DialogDescription>
            WSS 入站依赖远程服务器的 nginx + TLS 证书,以下条件须全部满足才能自动配置。
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-3 text-sm'>
          <CheckRow
            label='远程服务器已安装并运行 nginx'
            ok={!loading && nginxOk}
            loading={loading}
            note={
              !loading && !nginxOk
                ? statusQ.data?.nginx?.installed
                  ? 'nginx 已安装但未运行,请到「服务管理」启动'
                  : 'nginx 未安装,请到「服务管理」一键安装'
                : statusQ.data?.nginx?.version || ''
            }
          />
          <CheckRow
            label='已有可用 TLS 证书'
            ok={!loading && hasCert}
            loading={loading}
            note={
              !loading && nginxOk && !hasCert
                ? '请到「证书管理」添加该服务器域名的证书'
                : !loading && hasCert
                  ? `共 ${certsQ.data?.length} 张证书可用`
                  : ''
            }
          />
        </div>

        {(showNginxMissing || showCertMissing) && (
          <div className='mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-700 dark:border-amber-400/60 dark:bg-amber-900/20 dark:text-amber-200'>
            条件未满足,本 dialog 不会自动关闭。可点下方「我手动配置」复制 nginx 配置模板,
            ssh 到服务器自行粘贴 + 配证书。配好后再回来重新选 WSS。
          </div>
        )}

        {showManual && (
          <div className='mt-2 space-y-2'>
            <div className='flex items-center justify-between'>
              <span className='text-sm font-medium'>nginx 配置模板</span>
              <Button
                size='sm'
                variant='outline'
                onClick={handleCopyManual}
                className='gap-1.5'
              >
                <Copy className='h-3.5 w-3.5' />
                复制
              </Button>
            </div>
            <pre className='max-h-[280px] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed'>
              <code>
                {NGINX_MANUAL_TEMPLATE.replace(
                  '<您的域名>',
                  serverDomain || '<您的域名>',
                )}
              </code>
            </pre>
            <p className='text-xs text-muted-foreground'>
              将上面内容保存到远程服务器的 nginx servers/&lt;域名&gt;.conf,把 &lt;...&gt; 占位符替换为实际值,
              然后 nginx -t &amp;&amp; nginx -s reload 生效。
            </p>
          </div>
        )}

        <DialogFooter className='gap-2'>
          {(showNginxMissing || showCertMissing) && !showManual && (
            <Button variant='outline' onClick={() => setShowManual(true)}>
              我手动配置
            </Button>
          )}
          <Button variant='secondary' onClick={() => onOpenChange(false)}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CheckRow({
  label,
  ok,
  loading,
  note,
}: {
  label: string
  ok: boolean
  loading: boolean
  note?: string
}) {
  return (
    <div className='flex items-start gap-2'>
      {loading ? (
        <div className='mt-0.5 h-4 w-4 animate-pulse rounded-full bg-muted-foreground/30' />
      ) : ok ? (
        <CheckCircle2 className='mt-0.5 h-4 w-4 shrink-0 text-emerald-500' />
      ) : (
        <XCircle className='mt-0.5 h-4 w-4 shrink-0 text-red-500' />
      )}
      <div className='flex-1'>
        <div>{label}</div>
        {note && <div className='text-xs text-muted-foreground'>{note}</div>}
      </div>
    </div>
  )
}
