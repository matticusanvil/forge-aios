# Troubleshooting

**Forge's log** has the details for most problems. In the Windows app, right-click the tray icon and choose **Open the log**. The log is at `%APPDATA%\Forge AIOS\server.log`. In server mode, run `docker logs forge-aios`.

### Setup says Claude Code isn't installed, but I installed it

Click **Install** again, or quit Forge AIOS and open it again. If that doesn't help, open PowerShell and run `irm https://claude.ai/install.ps1 | iex` to reinstall it. Forge looks for it in `%USERPROFILE%\.local\bin\claude.exe`.

### The sign-in step never turns green

Make sure you finished Claude Code's sign-in: it says you're signed in before you close its window. Then wait a few seconds; setup checks every 3 seconds. Still stuck? Click **Sign in** again and look for an error in the Claude Code window.

### Git didn't install

Install it yourself from [git-scm.com](https://git-scm.com/downloads/win), keeping the installer's default options. Then click **Check again**.

### "Windows protected your PC" when installing

See step 2 of the [install guide](install-windows.md#2-install).

### The top bar says "Not logged in"

Claude Code's sign-in has expired or was removed. Quit Forge AIOS from the tray icon and open it again: setup reopens at the sign-in step.

### The top bar says Claude Code is newer than this Forge was tested with

Claude Code updates itself, and this version of Forge hasn't been tested with that version yet. Usually everything still works. If something misbehaves, check for a Forge AIOS update, or [open an issue](https://github.com/matticusanvil/forge-aios/issues).

### I can't delete or rename a project folder

Windows won't change a folder while a program is working inside it. Start a new session in another project, or quit Forge AIOS from the tray icon, then try again.

### Claude keeps asking for approval

Open **Rules → Approval level** and choose **Trusted project**. With **Ask**, every edit and command needs your approval until you click **Allow for session** for it.

### I hit my Claude plan's usage limit

The top bar shows your five-hour and weekly usage. Lower **Rules → Agent limits** so fewer agents run at once, or wait for the window to reset.

### Something else

[Open an issue](https://github.com/matticusanvil/forge-aios/issues/new/choose). Include what you did, what happened, and the end of the log. Remove anything private from the log first.
