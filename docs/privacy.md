# Privacy

Forge AIOS collects nothing about you. It has no accounts, no analytics and no telemetry, and Anvil Digital runs no server that it talks to.

Your sessions, approvals, rules and history stay on your computer: in `%APPDATA%\Forge AIOS` for the Windows app, or in the `forge-aios-data` volume in server mode.

## What reaches the internet, and why

| What | When | Where it goes |
| --- | --- | --- |
| **Your work with Claude** | Whenever you use a session. Claude Code sends your messages, and the files and command output it works with, to Anthropic. | Anthropic, under [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy) and the terms of your Claude plan or API account. Claude Code is Anthropic's program; Forge runs it unmodified. |
| **Update check** (Windows app) | Each time the app starts | GitHub Releases for this repository. It's a normal download request, so GitHub sees your IP address; nothing about you or your work is sent. |
| **Installing Git and Claude Code** (Windows app setup) | Only when you click **Install** | Git comes through Windows Package Manager (winget) or git-scm.com; Claude Code from Anthropic's installer at claude.ai. |
| **Phone approvals** | Only if you turn them on and give an ntfy server | The ntfy server you chose. It receives what each approval asks, for example the command Claude wants to run. |
| **Cloning or publishing repos** | Only when you ask | GitHub, using your own git or GitHub sign-in. |

That's all. Forge loads no fonts, scripts or images from other sites.
