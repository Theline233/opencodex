# 涓滀含鏈嶅姟鍣ㄤ竴閿儴缃?
鍙屽嚮 `deploy.cmd` 浼氬彂甯冨綋鍓?Git 鎻愪氦銆傝剼鏈細渚濇瀹屾垚鐜鑷銆佹墦鍖呫€佷笂浼犮€佹湇鍔″櫒鏋勫缓銆佸洖褰掓祴璇曘€?0101 绔彛鐏板害銆丏eepSeek 瀹為檯娴佸紡璇锋眰楠岃瘉锛屽叏閮ㄩ€氳繃鍚庢墠鍒囨崲 10100 鐢熶骇鏈嶅姟銆?
## 绗竴娆″湪鏂扮數鑴戜娇鐢?
1. 瀹夎骞剁櫥褰?Tailscale锛岀‘璁ゅ彲浠ヨ闂?`opencodex-tokyo.tail0dc240.ts.net`銆?2. Windows 闇€瑕?PowerShell銆丟it 鍜?OpenSSH銆傝剼鏈細鑷姩鏌ユ壘绯荤粺鑷甫 OpenSSH 鍜屽父瑙?Git 瀹夎浣嶇疆銆?3. 灏?SSH 绉侀挜鍛藉悕涓?`deploy-key.pem` 鏀惧湪鏈洰褰曪紝鎴栬缃幆澧冨彉閲?`OPENCODEX_DEPLOY_KEY` 鎸囧悜绉侀挜銆傜閽ユ枃浠跺凡琚粨搴撳拷鐣ワ紝缁濅笉鑳芥彁浜ゅ埌 Git銆?4. 纭繚闇€瑕佸彂甯冪殑鏀瑰姩宸茬粡鎻愪氦锛岀劧鍚庡弻鍑?`deploy.cmd`銆?
涔熷彲浠ヤ粠 PowerShell 鎸囧畾鍙傛暟锛?
```powershell
.\ops\tokyo\deploy.ps1 -Action Deploy -KeyPath D:\Downloads\gs.pem
```

## 鍥炴粴涓庣姸鎬?
- 鍙屽嚮 `status.cmd` 鏌ョ湅褰撳墠鐗堟湰銆佷笂涓€鐗堟湰銆乻ystemd 鐘舵€佸拰鍋ュ悍妫€鏌ャ€?- 鍙屽嚮 `rollback.cmd` 鍘熷瓙鍒囧洖涓婁竴鐗堟湰锛涜嫢涓婁竴鐗堟湰鍋ュ悍妫€鏌ュけ璐ワ紝鑴氭湰浼氳嚜鍔ㄦ仮澶嶈緝鏂扮殑鐗堟湰銆?
鏈嶅姟鍣ㄤ笂鐨勭増鏈綅浜?`~/.local/share/opencodex-deploy/releases`銆傞儴缃蹭笉浼氳鐩?`~/.opencodex` 涓殑閰嶇疆銆佽处鍙枫€佺敤閲忓拰鏃ュ織锛屼篃涓嶄細鍒犻櫎鏃х増鏈€?
## 瀹夊叏杈圭晫

- 鍙戝竷鍖呭彧鏉ヨ嚜骞插噣鐨?Git `HEAD`锛屾湁鏈彁浜ゅ彉鏇存椂鑴氭湰浼氭嫆缁濋儴缃层€?- 涓婁紶鍖呬娇鐢?SHA-256 鏍￠獙銆?- 鐏板害澶辫触涓嶄細淇敼鐢熶骇锛涚敓浜у垏鎹㈠け璐ヤ細鎭㈠鏃ц蒋閾炬帴銆佹棫 unit 骞堕噸鍚棫鏈嶅姟銆?- 浠撳簱鍙褰曡剼鏈拰婧愮爜锛屼笉璁板綍 SSH 绉侀挜銆丄PI token 鎴栬处鍙烽厤缃€?
## 模型目录同步（已知问题与修复）

服务器模型发布链路由两部分组成：

1. `opencodex-catalog-publish.service`（oneshot）：把 `~/.codex/opencodex-catalog.json` 发布到 `~/opencodex-model-sync/`；
2. Syncthing（`opencodex-model-syncthing.service`，服务器端 sendonly）单向同步到本机 `C:\Users\1\.codex-server-catalog\`，本机 Codex 通过 `model_catalog_json` 直接读取。

2026-08-06 故障：发布服务因触发过快进入 `start-limit-hit` 锁死（8/4 起），新模型一直未发布。修复：

- `systemctl --user reset-failed opencodex-catalog-publish.service`
- 手动执行 `/home/ubuntu/.local/bin/publish-opencodex-catalog` 补发一次
- 添加 drop-in 防止复发：`~/.config/systemd/user/opencodex-catalog-publish.service.d/override.conf` 写入 `[Service] StartLimitIntervalSec=0 StartLimitBurst=0`，然后 `systemctl --user daemon-reload`

排查命令：`cmp -s ~/.codex/opencodex-catalog.json ~/opencodex-model-sync/opencodex-catalog.json`（一致表示已发布）；本机检查 `C:\Users\1\.codex-server-catalog\opencodex-catalog.json` 的模型数与时间戳。
