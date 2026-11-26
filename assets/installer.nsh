; Taken in by electron-builder from the build resources folder.
; Its uninstaller leaves the .pvproj association behind, which would point at a program that is gone.
; An update runs the old uninstaller first, and the association stays through that.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\.pvproj"
    DeleteRegKey HKCU "Software\Classes\Pulseforge project"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ${endIf}
!macroend
