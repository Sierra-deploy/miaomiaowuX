
# 妙妙屋X - Xray 服务器管理与订阅拼车系统

<div align="center">
  <img height="200px" src="https://raw.githubusercontent.com/iluobei/miaomiaowuX/refs/heads/main/miaomiaowux-frontend/public/images/logo.webp" />
</div>

妙妙屋X 是 [妙妙屋](https://github.com/iluobei/miaomiaowu) 的增强版本，在原有 Clash 订阅管理基础上，新增 Xray 多服务器管理、远程节点部署、流量监控、证书管理等功能。支持主控/子服务器架构，通过 [mmw-agent](https://github.com/iluobei/mmw-agent) 实现远程服务器的统一管理。

## 功能特性

### Xray 服务器管理（新增）
- 🖥️ 多服务器管理 - 主控统一管理多台远程 Xray 服务器
- 🔌 远程连接 - WebSocket / HTTP / Pull 三种连接模式，自动回退
- 📊 实时流量 - 各服务器流量统计与实时速度监控
- 🔧 远程配置 - 在线管理远程服务器的 Xray/Nginx 配置
- 📡 入站/出站管理 - 可视化管理 Xray 入站、出站、路由规则
- 🔐 证书管理 - ACME 自动申请/续期 SSL 证书，支持多种 DNS 提供商
- 🚀 一键部署 - 远程服务器一键安装 Xray + Nginx + Agent
- 📦 套餐管理 - 用户套餐与流量限额管理
- 🔄 节点同步 - 入站变更自动同步到订阅节点

### 订阅管理（继承自妙妙屋）
- 📊 流量监控 - 支持 Xray 流量采集与外部订阅流量聚合统计
- 📈 历史流量 - 30 天流量使用趋势图表
- 📦 节点管理 - 导入个人节点或机场节点，支持批量操作
- 👥 用户管理 - 管理员/普通用户角色区分，订阅权限管理
- 🌓 主题切换 - 支持亮色/暗色模式

### 支持的客户端格式
Clash(Meta) / Surge / Loon / Quantumult X / Shadowrocket / SingBox / Stash / Surfboard / V2Ray / Egern

## 安装部署

### 方式 1：一键安装（推荐）

```bash
curl -sL https://raw.githubusercontent.com/iluobei/miaomiaowuX/main/install.sh | sudo bash
```

自动检测架构、下载最新版本、创建 systemd 服务。安装完成后访问 `http://服务器IP:12889` 进入初始化向导。

更新：
```bash
curl -sL https://raw.githubusercontent.com/iluobei/miaomiaowuX/main/install.sh | sudo bash -s update
```

卸载：
```bash
curl -sL https://raw.githubusercontent.com/iluobei/miaomiaowuX/main/install.sh | sudo bash -s uninstall
```

### 方式 2：Docker 部署

```bash
docker run -d \
  --user root \
  --name miaomiaowux \
  -p 12889:12889 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/subscribes:/app/subscribes \
  -v $(pwd)/rule_templates:/app/rule_templates \
  ghcr.io/iluobei/miaomiaowux:latest
```

#### Docker Compose

```yaml
version: '3.8'

services:
  miaomiaowux:
    image: ghcr.io/iluobei/miaomiaowux:latest
    container_name: miaomiaowux
    restart: unless-stopped
    user: root
    environment:
      - PORT=12889
      - LOG_LEVEL=info
    ports:
      - "12889:12889"
    volumes:
      - ./data:/app/data
      - ./subscribes:/app/subscribes
      - ./rule_templates:/app/rule_templates
```

### 方式 3：二进制部署

从 [Releases](https://github.com/iluobei/miaomiaowuX/releases) 下载对应平台的二进制文件：

```bash
# Linux
chmod +x mmwx-linux-amd64
./mmwx-linux-amd64

# 或指定配置文件
./mmwx-linux-amd64 -c config.yaml
```

默认端口 `12889`，访问 `http://服务器IP:12889` 进入初始化向导。

### 远程服务器部署

在主控面板添加远程服务器后，会生成一键安装命令，在远程服务器上执行即可自动安装 [mmw-agent](https://github.com/iluobei/mmw-agent) 并连接到主控。

## 架构

```
┌─────────────────────────────────────────┐
│           妙妙屋X (主控)                 │
│                                         │
│  订阅管理 / Xray管理 / 证书管理 / 用户管理 │
│  流量统计 / 套餐管理 / 节点同步           │
└────────────────┬────────────────────────┘
                 │ WebSocket / HTTP / Pull
    ┌────────────┼────────────┐
    ▼            ▼            ▼
┌────────┐  ┌────────┐  ┌────────┐
│ Agent1 │  │ Agent2 │  │ Agent3 │
│ (Xray) │  │ (Xray) │  │ (Xray) │
└────────┘  └────────┘  └────────┘
```

## 配置文件

```yaml
mode: master              # master（默认）或 remote
port: "12889"             # 监听端口
# 以下为 remote 模式配置
master_server: ""         # 主控地址
remote_token: ""          # 服务器令牌
connection_mode: "auto"   # auto | websocket | http | pull
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `12889` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `JWT_SECRET` | 会话令牌签名密钥，设置后 token 使用 HMAC 签名，更换密钥会使所有会话失效。未设置则使用纯随机 token | 未设置 |
| `ALLOWED_ORIGINS` | CORS 允许来源 | `*` |
| `MMWX_MODE` | 运行模式 | `master` |

## 技术栈

- 后端：Go 1.25 + net/http + SQLite (modernc.org/sqlite)
- 前端：React 19 + Vite 7 + TanStack Router + TailwindCSS 4 + shadcn/ui
- 单二进制部署，前端通过 Go embed 嵌入

## ⚠️ 免责声明

- 本程序仅供学习交流使用，请勿用于非法用途
- 使用本程序需遵守当地法律法规
- 作者不对使用者的任何行为承担责任

<details>
<summary>更新日志</summary>

### v0.2.2 (2026-06-08)
- 🌈前后端交互安全加固
- 🌈套餐管理显示优化
- 🌈手机端适配优化
- 🌈支持按入站+用户限速
- 🛠️ fix:下发TLS证书连接失败
- 🛠️ fix:找回密码脚本错误
- 🛠️ fix:暴力探测接口拉黑失败
- 🛠️ fix:简易模式证书自动配置失败
### v0.2.1 (2026-06-05)
- 🌈支持cloudflare turnstile 验证码
- 🛠️ fix: tgbot用户注册后无法访问节点
- 🛠️ fix: 检查版本号逻辑
### v0.2.0 (2026-06-04)
- 🌈MCP功能补全
- 🌈TG BOT开发测试
- 🌈TGBOT支持邀请码注册绑定套餐
- 🌈优化lxc容器的识别
- 🌈优化xray路由管理与出站管理
- 🌈支持TgBot和MiniApp
- 🌈支持节点单独设置倍率与倍率展示
- 🌈迁移妙妙屋代理组编辑的中转代理组功能
- 🛠️ fix: 修改插件默认组织
- 🛠️ fix: 功能性BUG修复
- 🛠️ fix: 每日流量折线图重启错误统计数据
- 🛠️ fix: 节点流量用户展示错误
- 🛠️ fix:出招allowinsecure改为pinnedPeerCertSha256
- 🛠️ fix:出站allowinsecure改为pinnedPeerCertSha256
- 🛠️ fix:已经是路由出站的节点不能再次添加路由出站
### v0.1.9 (2026-06-02)
- 🌈Xray管理路由规则管理优化
- 🌈支持AnyTLS
- 🌈证书上传功能优化
- 🛠️ fix:ss节点配置错误
- 🛠️ fix:前端UI功能优化
### v0.1.8 (2026-06-01)
- 🌈增加服务在线离线筛选
- 🌈增加自定义安全管控配置
- 🛠️ fix:历史版本使用user@email的流量未统计补丁
- 🛠️ fix:安全规则无法识别docker与反代环境的真实IP
- 🛠️ fix:离线通知IP错误
### v0.1.7 (2026-05-31)
- 🌈增加自定义安全管控配置
- 🛠️ fix:ss2022多用户密码拼接错误
- 🛠️ fix:添加服务器的安装命令丢失参数
- 🛠️ fix:用户流量统计聚合逻辑错误
### v0.1.6 (2026-05-30)
- 🌈优化主控使用CDN情况下的Agent互联
- 🛠️ fix:dialog溢出屏幕问题
- 🛠️ fix:docker开启https后无法访问
- 🛠️ fix:代理集合接口查询404
- 🛠️ fix:偶发Agent上报ipv6
- 🛠️ fix:恢复doh使用IP
- 🛠️ fix:模板dns配置不可用的覆盖补丁
- 🛠️ fix:点击模板管理报错缓存读取失败
- 🛠️ fix:订阅管理流量显示错误
- 🛠️ fix:许可证限制错误的应用在外部节点上
### v0.1.5 (2026-05-29)
- 🛠️ fix:dns配置错误
- 🛠️ fix:模板越权问题
- 🛠️ fix:调整普通用户的查看权限
- 🛠️ fix:路由出站功能BUG
- 🛠️ fix:迁移的用户订阅错误
### v0.1.4 (2026-05-28)
- 🌈代理集合前端代码优化
- 🌈优化xray管理代码结构
- 🌈优化编辑节点代码结构
- 🛠️ fix:Agent安装的主控地址错误
- 🛠️ fix:修复若干BUG
- 🛠️ fix:测速页面UIBUG
### v0.1.3 (2026-05-26)
- 🌈合并妙妙屋更新补丁
- 🌈增加妙妙屋迁移入口
- 🌈增加路由出站功能
- 🌈支持从妙妙屋迁移
- 🌈支持节点真延迟测试
- 🌈支持路由出站（入站复用）
- 🛠️ fix:debian13nginx安装失败
- 🛠️ fix:分享的服务器xray_mode没有解析
- 🛠️ fix:自定义Agent端口无效
- 🛠️ fix:自定义规则BUG修复
### v0.1.2 (2026-05-23)
- 🌈测速结果支持出口IP显示
- 🛠️ fix:订阅管理报错
### v0.1.1 (2026-05-23)
- 🌈增加MCP服务，可以接入openclaw或hermes
- 🛠️ fix:数据库增量更新顺序错误
### v0.1.0 (2026-05-22)
- 🛠️ fix:测速代码丢失
### v0.0.10 (2026-05-22)
- 🌈主控支持mihomo测速
- 🌈优化tunnel的配置流程与管理
- 🌈增加xray负载均衡出站配置
- 🌈增加节点测速
- 🌈支持HY2协议
- 🛠️ fix:Dokcer镜像打包失败
- 🛠️ fix:上报间隔配置不生效
- 🛠️ fix:服务器轮换密钥时短暂假离线
- 🛠️ fix:流量信息页面流量始终为0
- 🛠️ fix:系统配置异常丢失
### v0.0.9 (2026-05-21)
- 🌈 同步妙妙屋订阅管理
- 🌈 增加限速单位换算提示
- 🌈优化与licenseserver交互
- 🌈优化与许可证服务交互
- 🌈增加上报频率设置
- 🌈增加批量升级agent
- 🌈支持分享服务器给其他妙妙屋X
- 🌈支持普通用户访问部分妙妙屋功能
- 🌈支持用户配置自定义短码
- 🌈用户禁用时删除节点里的用户配置
- 🛠️ fix:Agent缺少某些错误提示
- 🛠️ fix:优化服务管理
- 🛠️ fix:流量统计错误
- 🛠️ fix:添加节点现在仅添加当前用户
- 🛠️ fix:缺少节点流量统计
- 🛠️ fix:迁移妙妙屋最新补丁
- 🛠️ fix:限速失败
- 🛠️ fix:首页用户网速显示错误
### v0.0.8 (2026-05-18)
- 🛠️ fix:交换密钥失败导致session断开
- 🛠️ fix:服务器卡片界面显示问题
- 🛠️ fix:用户管理绑定套餐看不见套餐
- 🛠️ fix:节点管理ip域名恢复错误
### v0.0.7 (2026-05-18)
- 🌈 增加与agent交互的错误提示
- 🌈 增加主控与agent交互协议展示
- 🛠️ fix:优化内嵌xray菜单展示
- 🛠️ fix:优化许可证展示
- 🛠️ fix:优化顶部菜单展示
- 🛠️ fix:添加服务器窗口异常撑大
### v0.0.6 (2026-05-18)
- 🛠️ fix:docker镜像打包系统版本不对
- 🛠️ fix:reality节点创建多了出站
### v0.0.5-beta (2026-05-18)
- 🛠️ fix:agent自动上报IPv4优先
### v0.0.5 (2026-05-18)
- 🛠️ fix:主控开启小黄云获取agent IP错误
### v0.0.4 (2026-05-17)
- 🌈 PRO功能展示优化
- 🌈 优化发布脚本
- 🌈 增加妙妙屋菜单
- 🌈 妙妙屋功能增加开关控制
- 🛠️ fix:同步妙妙屋修改
- 🛠️ fix:证书保存目录错误写死了/etc
### v0.0.4-beta (2026-05-17)
- 🛠️ fix:cloudflare证书不再本地验证dns
- 🛠️ fix:自动限速无法恢复
- 🌈 增加自动限速与解除限速
- 🛠️ fix:主控与偷自己逻辑优化
- 🌈 增加主控与agent交互加密
- 🌈 增加证书申请日志显示
- 🛠️ fix:修复大量bug
- 🌈 同步mmw功能
- 🌈 支持内联xray与外置xray切换
### v0.0.3-beta (2026-05-14)
- 🌈 支持套餐限速与用户限速
- 🌈 支持套餐限速与用户限速
- 🌈 同步mmw功能
- 🌈 同步mmw功能
### v0.0.2 (2026-05-13)
- 🛠️ fix:移植外部订阅功能
- 🛠️ fix:topbar 按钮阴影消失
- 🌈 支持i18n
- 🌈 支持扁平主题
- 🌈 优化发布流程
- 🌈 增加2fa
- 🌈 增加通知
- 🌈 允许用户自行添加出站
</details>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=iluobei/miaomiaowuX&type=date&legend=top-left)](https://www.star-history.com/#iluobei/miaomiaowuX&type=date&legend=top-left)

## 许可证

MIT License

## 联系方式

- 问题反馈：[GitHub Issues](https://github.com/iluobei/miaomiaowuX/issues)
- 功能建议：[GitHub Discussions](https://github.com/iluobei/miaomiaowuX/discussions)
