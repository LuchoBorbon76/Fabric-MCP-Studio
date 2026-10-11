FABRIC MCP STUDIO - INSTALLER
=============================

Fabric MCP Studio builds Microsoft Fabric workspaces, semantic models, ontologies, Power BI reports and more by chatting
with the Copilot or AI provider you already use. It runs on your computer and signs in to Fabric as you.

This installer downloads the app from its GitHub repository and sets everything up:

  Repository : {{REPO}}
  Branch     : {{BRANCH}}
  Folder     : {{INSTALLDIR}}   (change it with -InstallDir)
  Built      : {{BUILT}} from version {{VERSION}} - the installer always installs the newest version of the branch


INSTALL
-------
1. Extract this zip file (right-click > Extract All). Don't run the files from inside the zip.
2. Open this README.txt if you need quick install/update/uninstall instructions. For a complete app walkthrough, open
   "Fabric-MCP-Studio-User-Guide.pdf" in the same folder.
3. Double-click "Install Fabric MCP Studio.cmd".
4. Answer the questions. The installer:
   - checks the prerequisites and shows what is installed, missing or too old;
   - installs what is missing (it asks first; Windows may ask for permission):
       required : Git (with Git Credential Manager), Node.js LTS {{MINNODE}} or later (with npm)
       optional : Azure CLI (reuse "az login"), GitHub CLI (GitHub Copilot sign-in)
   - downloads the app (a private repository opens a GitHub sign-in window once - sign in with an account that has
     access to the repository);
   - installs the app's packages (about 150 MB);
   - creates the "Fabric MCP Studio" desktop shortcut and offers to start the app.
5. In the app: sign in with your Microsoft Entra work account, choose your AI provider in Settings, then select
   "Check setup". If anything is yellow or red, open Settings > Fix prerequisites for exact fixes and admin links.

Only want to see what is installed? Double-click "Check prerequisites.cmd" (it changes nothing).


INSTRUCTIONS FILES
------------------
- README.txt (this file): installer instructions, update/uninstall steps, command-line options and troubleshooting.
- Fabric-MCP-Studio-User-Guide.pdf: full step-by-step app instructions with screenshots, written for people without a
  technical background.
- After install, the same guide is also in the app folder under docs\Fabric-MCP-Studio-User-Guide.pdf.


UPDATE
------
Run "Install Fabric MCP Studio.cmd" again. It updates the app in place (git pull) and keeps your projects, chats and
settings (studio\data). If the app is running, the installer closes it first and starts it again afterwards (also when
the update fails). A copy installed from the zip (without Git) switches to Git updates once Git is installed.
Inside the app, "Restart now" appears when a newer version is on disk.


UNINSTALL
---------
Double-click "Uninstall Fabric MCP Studio.cmd". It removes its shortcuts and the app folder; your projects, chats and
settings are moved next to the folder (FabricMCPStudio-data-<date>). Git, Node.js and the other tools stay installed.
A shortcut with the same name that opens another copy of the studio (installed in another folder) is kept.


OPTIONS (PowerShell)
--------------------
  powershell -ExecutionPolicy Bypass -File files\Install-FabricMCPStudio.ps1 [options]

  -CheckOnly           only show the prerequisites
  -Yes                 answer yes to every question (unattended)
  -InstallOptional     also install Azure CLI and GitHub CLI when missing
  -SkipOptional        never offer the optional tools
  -StartMenu           also add a Start menu shortcut
  -NoShortcut          no shortcuts
  -Launch              start the app at the end
  -InstallDir <path>   install somewhere else (avoid OneDrive folders)
  -RepoUrl <url>       install from another copy of the repository
  -Branch <name>       install another branch
  -ShortcutName <name> another shortcut name
  -GitHubToken <token> download a private repository without Git
  -Uninstall [-KeepData]

The defaults are in files\installer.config.json.


TROUBLESHOOTING
---------------
- Every run writes a log to %TEMP%\FabricMCPStudio-install-<date>.log (the installer shows the path).
- "The repository or branch can't be read": your GitHub account needs access to the repository. Open the repository
  address above in a browser with the same account; ask the owner to share it with you.
- Downloads blocked: the installer needs github.com and registry.npmjs.org (and nodejs.org / winget sources to install
  Node.js). Behind a proxy: npm config set proxy http://proxy:port and git config --global http.proxy http://proxy:port.
- A tool was installed but "isn't available yet": close the window and run the installer again (Windows updates the
  PATH for new windows).
- Windows Script Host turned off by policy: the shortcut opens the app from a minimized console window instead.

Sample app provided as is - not an official Microsoft product or supported service.
