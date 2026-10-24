; The installer's own page (electron-builder.yml, nsis.include): what else to do besides copying the program.
; A desktop shortcut, Ollama for free models on this computer, and the picture engine. Drimvox installs those two on its
; first start, with the progress on the local models' sheet (apps/desktop/src/main.ts reads the notes left here). Updates run silently and
; never show this page, so they change nothing of what was chosen.
; Russian or English by the system's language (1049 is Russian).

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var DrimvoxDesktopBox
  Var DrimvoxOllamaBox
  Var DrimvoxNoDesktop
  Var DrimvoxOllama
  Var DrimvoxImagesBox
  Var DrimvoxImages

  ; A welcome page, with Drimvox's picture beside it like the last one; an update skips it.
  !macro customWelcomePage
    !insertmacro skipPageIfUpdated
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  ; The page's functions live in the macro: this file is read before electron-builder's helpers (isUpdated and the
  ; rest), the macro is expanded after them.
  !macro customPageAfterChangeDir
    Page custom DrimvoxOptionsPage DrimvoxOptionsLeave

  Function DrimvoxOptionsPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} $LANGUAGE == 1049
      !insertmacro MUI_HEADER_TEXT "Параметры установки" "Что ещё сделать, кроме установки Drimvox"
    ${Else}
      !insertmacro MUI_HEADER_TEXT "Install options" "What else to do besides installing Drimvox"
    ${EndIf}

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${If} $LANGUAGE == 1049
      ${NSD_CreateCheckbox} 0 0 100% 12u "Ярлык на рабочем столе"
    ${Else}
      ${NSD_CreateCheckbox} 0 0 100% 12u "Desktop shortcut"
    ${EndIf}
    Pop $DrimvoxDesktopBox
    ${If} $DrimvoxNoDesktop == "1"
      ${NSD_Uncheck} $DrimvoxDesktopBox
    ${Else}
      ${NSD_Check} $DrimvoxDesktopBox
    ${EndIf}

    ${If} $LANGUAGE == 1049
      ${NSD_CreateLabel} 12u 14u -12u 18u "Ярлык в меню «Пуск» будет всегда: без него Windows не показывает уведомления Drimvox."
    ${Else}
      ${NSD_CreateLabel} 12u 14u -12u 18u "The Start menu shortcut is always made: without it Windows does not show Drimvox's notifications."
    ${EndIf}
    Pop $0

    ${If} $LANGUAGE == 1049
      ${NSD_CreateCheckbox} 0 42u 100% 12u "Установить Ollama — бесплатные нейросети на этом компьютере"
    ${Else}
      ${NSD_CreateCheckbox} 0 42u 100% 12u "Install Ollama: free AI models right on this computer"
    ${EndIf}
    Pop $DrimvoxOllamaBox
    ${If} $DrimvoxOllama == "1"
      ${NSD_Check} $DrimvoxOllamaBox
    ${EndIf}

    ${If} ${FileExists} "$LOCALAPPDATA\Programs\Ollama\ollama.exe"
      EnableWindow $DrimvoxOllamaBox 0
      ${NSD_Uncheck} $DrimvoxOllamaBox
      ${If} $LANGUAGE == 1049
        ${NSD_CreateLabel} 12u 56u -12u 18u "Ollama уже установлена: Drimvox найдёт её сам."
      ${Else}
        ${NSD_CreateLabel} 12u 56u -12u 18u "Ollama is already installed: Drimvox will find it."
      ${EndIf}
    ${Else}
      ${If} $LANGUAGE == 1049
        ${NSD_CreateLabel} 12u 56u -12u 26u "Drimvox скачает её при первом запуске (около 1 ГБ) и покажет, сколько осталось. Можно и позже: «Локальные модели» в Drimvox."
      ${Else}
        ${NSD_CreateLabel} 12u 56u -12u 26u "Drimvox downloads it on its first start (about 1 GB) and shows how much is left. It can wait too: Local models in Drimvox."
      ${EndIf}
    ${EndIf}
    Pop $0

    ; The picture engine (docs/specs/local-images.md): small, so it may come at once; models are chosen in Drimvox.
    ${If} $LANGUAGE == 1049
      ${NSD_CreateCheckbox} 0 88u 100% 12u "Подготовить картинки на этом компьютере (движок stable-diffusion.cpp)"
    ${Else}
      ${NSD_CreateCheckbox} 0 88u 100% 12u "Prepare pictures on this computer (the stable-diffusion.cpp engine)"
    ${EndIf}
    Pop $DrimvoxImagesBox
    ${If} $DrimvoxImages == "1"
      ${NSD_Check} $DrimvoxImagesBox
    ${EndIf}
    ${If} $LANGUAGE == 1049
      ${NSD_CreateLabel} 12u 102u -12u 26u "Около 30 МБ при первом запуске. Модели картинок (от 6 ГБ) выбираются потом в «Локальных моделях»: бесплатно и без интернета."
    ${Else}
      ${NSD_CreateLabel} 12u 102u -12u 26u "About 30 MB on the first start. Picture models (6 GB and more) are chosen later on the Local models sheet: free and offline."
    ${EndIf}
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function DrimvoxOptionsLeave
    ${NSD_GetState} $DrimvoxDesktopBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $DrimvoxNoDesktop "0"
    ${Else}
      StrCpy $DrimvoxNoDesktop "1"
    ${EndIf}
    ${NSD_GetState} $DrimvoxOllamaBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $DrimvoxOllama "1"
    ${Else}
      StrCpy $DrimvoxOllama "0"
    ${EndIf}
    ${NSD_GetState} $DrimvoxImagesBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $DrimvoxImages "1"
    ${Else}
      StrCpy $DrimvoxImages "0"
    ${EndIf}
  FunctionEnd
  !macroend

  !macro customInstall
    ${If} $DrimvoxNoDesktop == "1"
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
    ${EndIf}
    ${If} $DrimvoxOllama == "1"
      FileOpen $0 "$INSTDIR\install-ollama" w
      FileClose $0
    ${EndIf}
    ${If} $DrimvoxImages == "1"
      FileOpen $0 "$INSTDIR\install-images" w
      FileClose $0
    ${EndIf}
  !macroend
!endif
