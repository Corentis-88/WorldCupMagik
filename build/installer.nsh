!ifndef BUILD_UNINSTALLER
!define MUI_CUSTOMFUNCTION_GUIINIT WorldCupMagikInstallerSplash

Function WorldCupMagikInstallerSplash
  InitPluginsDir
  File /oname=$PLUGINSDIR\worldcupmagik-splash.bmp "${BUILD_RESOURCES_DIR}\installerSplash.bmp"
  BgImage::SetBg $PLUGINSDIR\worldcupmagik-splash.bmp
  BgImage::Redraw
  Sleep 3000
  BgImage::Destroy
FunctionEnd
!endif
