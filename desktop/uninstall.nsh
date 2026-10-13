; Uninstalling asks whether to keep Forge AIOS's history and settings. Project folders are never removed.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Also remove Forge AIOS's session history and settings?$\r$\n$\r$\nYour project folders are never removed, whichever you choose." /SD IDNO IDNO keep
      RMDir /r "$APPDATA\Forge AIOS"
    keep:
  ${endIf}
!macroend
