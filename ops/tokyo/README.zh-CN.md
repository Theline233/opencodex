# 东京服务器一键部署

双击 `deploy.cmd` 会发布当前 Git 提交。脚本会依次完成环境自检、打包、上传、服务器构建、回归测试、10101 端口灰度、DeepSeek 实际流式请求验证，全部通过后才切换 10100 生产服务。

## 第一次在新电脑使用

1. 安装并登录 Tailscale，确认可以访问 `opencodex-tokyo.tail0dc240.ts.net`。
2. Windows 需要 PowerShell、Git 和 OpenSSH。脚本会自动查找系统自带 OpenSSH 和常见 Git 安装位置。
3. 将 SSH 私钥命名为 `deploy-key.pem` 放在本目录，或设置环境变量 `OPENCODEX_DEPLOY_KEY` 指向私钥。私钥文件已被仓库忽略，绝不能提交到 Git。
4. 确保需要发布的改动已经提交，然后双击 `deploy.cmd`。

也可以从 PowerShell 指定参数：

```powershell
.\ops\tokyo\deploy.ps1 -Action Deploy -KeyPath D:\Downloads\gs.pem
```

## 回滚与状态

- 双击 `status.cmd` 查看当前版本、上一版本、systemd 状态和健康检查。
- 双击 `rollback.cmd` 原子切回上一版本；若上一版本健康检查失败，脚本会自动恢复较新的版本。

服务器上的版本位于 `~/.local/share/opencodex-deploy/releases`。部署不会覆盖 `~/.opencodex` 中的配置、账号、用量和日志，也不会删除旧版本。

## 安全边界

- 发布包只来自干净的 Git `HEAD`，有未提交变更时脚本会拒绝部署。
- 上传包使用 SHA-256 校验。
- 灰度失败不会修改生产；生产切换失败会恢复旧软链接、旧 unit 并重启旧服务。
- 仓库只记录脚本和源码，不记录 SSH 私钥、API token 或账号配置。
