; ============================================================
;  Trae / WorkBuddy 签到助手 —— Inno Setup 安装脚本
;  正常构建入口：powershell -File build\build.ps1
;  （它会暂存文件并传入 /DAppVersion /DSourceDir /DOutputDir）
;  手动编译：ISCC.exe /DAppVersion=1.0.0 /DSourceDir=..\build\app /DOutputDir=..\build\dist Setup.iss
; ============================================================
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\build\app"
#endif
#ifndef OutputDir
  #define OutputDir "..\build\dist"
#endif

[Setup]
; 固定 AppId：同一产品升级安装时复用目录与卸载记录
AppId={{8F4E1C7A-2B64-4D5E-9C31-5A0D6E9B7F22}
AppName=Trae 签到助手
AppVersion={#AppVersion}
AppPublisher=Trae-WorkBuzzer
AppPublisherURL=https://github.com/b-as-h/Trae-WorkBuzzer-
AppSupportURL=https://github.com/b-as-h/Trae-WorkBuzzer-/issues
; 装到用户目录：全程免管理员，也避免 Program Files 的写权限问题（config/state/log 都要可写）
DefaultDirName={localappdata}\Programs\TraeCheckin
DisableProgramGroupPage=yes
; 不显示分组选择页时必须显式指定默认分组名，否则快捷方式会落到名为 "(Default)" 的文件夹里
DefaultGroupName=Trae 签到助手
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=TraeCheckin-Setup-v{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
SetupIconFile=..\assets\checkin.ico
UninstallDisplayIcon={app}\assets\checkin.ico
UninstallDisplayName=Trae 签到助手
WizardStyle=modern
LicenseFile={#SourceDir}\LICENSE

; 中文语言文件来自官方 issrc 仓库 Files/Languages/ChineseSimplified.isl（随脚本入库）
[Languages]
Name: "chs"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "regtasks"; Description: "注册计划任务（每日自动签到 + 断网补签，推荐）"; GroupDescription: "附加选项："; Flags: checkedonce
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项："; Flags: unchecked

[Files]
; 程序全部文件（暂存目录已由 build.ps1 剔除凭证与日志；Excludes 双保险）
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "config.json,state\*,*.log,*.log.*"
; 首次安装从示例生成 config.json；升级安装绝不覆盖用户现有配置
Source: "{#SourceDir}\config.example.json"; DestDir: "{app}"; DestName: "config.json"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{group}\打开签到面板"; Filename: "{app}\ui.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\assets\checkin.ico"
Name: "{group}\状态总览"; Filename: "{app}\status.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\assets\checkin.ico"
Name: "{group}\手动签到一次"; Filename: "{app}\checkin.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\assets\checkin.ico"
Name: "{userdesktop}\Trae 签到助手"; Filename: "{app}\ui.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\assets\checkin.ico"; Tasks: desktopicon

[Run]
; 注册计划任务：register-task.ps1 按自身所在目录注册，装到哪就指向哪
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\register-task.ps1"""; StatusMsg: "正在注册计划任务（每日自动签到 + 断网补签）..."; Flags: runhidden waituntilterminated; Tasks: regtasks
Filename: "{app}\ui.cmd"; WorkingDir: "{app}"; Description: "打开签到面板"; Flags: postinstall shellexec skipifsilent

[UninstallRun]
; 卸载前先停「本目录」启动的面板，再只注销「指向本目录」的计划任务
; （两个脚本都做目录归属判断，绝不误伤其它安装方式的任务/进程）
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\stop-panel.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "StopPanel"
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall-tasks.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "UnregTasks"

[UninstallDelete]
; 注意：config.json / state\ / checkin.log **故意不删** —— 它们包含账号凭证与历史。
; 卸载后如需彻底清理，手动删除安装目录即可。
Type: files; Name: "{app}\panel-start.log"
