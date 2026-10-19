; The installer's own page (electron-builder.yml, nsis.include): what else to do besides copying the program.
; A desktop shortcut, and Ollama for free models on this computer; Artel installs Ollama on its first start, with the
; progress on the local models' sheet (apps/desktop/src/main.ts reads the note left here). Updates run silently and
; never show this page, so they change nothing of what was chosen.
; Russian or English by the system's language (1049 is Russian).

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var ArtelDesktopBox
  Var ArtelOllamaBox
  Var ArtelNoDesktop
  Var ArtelOllama

  ; A welcome page, with Artel's picture beside it like the last one; an update skips it.
  !macro customWelcomePage
    !insertmacro skipPageIfUpdated
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  ; The page's functions live in the macro: this file is read before electron-builder's helpers (isUpdated and the
  ; rest), the macro is expanded after them.
  !macro customPageAfterChangeDir
    Page custom ArtelOptionsPage ArtelOptionsLeave

  Function ArtelOptionsPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} $LANGUAGE == 1049
      !insertmacro MUI_HEADER_TEXT "Параметры установки" "Что ещё сделать, кроме установки Artel"
    ${Else}
      !insertmacro MUI_HEADER_TEXT "Install options" "What else to do besides installing Artel"
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
    Pop $ArtelDesktopBox
    ${If} $ArtelNoDesktop == "1"
      ${NSD_Uncheck} $ArtelDesktopBox
    ${Else}
      ${NSD_Check} $ArtelDesktopBox
    ${EndIf}

    ${If} $LANGUAGE == 1049
      ${NSD_CreateLabel} 12u 14u -12u 18u "Ярлык в меню «Пуск» будет всегда: без него Windows не показывает уведомления Artel."
    ${Else}
      ${NSD_CreateLabel} 12u 14u -12u 18u "The Start menu shortcut is always made: without it Windows does not show Artel's notifications."
    ${EndIf}
    Pop $0

    ${If} $LANGUAGE == 1049
      ${NSD_CreateCheckbox} 0 42u 100% 12u "Установить Ollama — бесплатные нейросети на этом компьютере"
    ${Else}
      ${NSD_CreateCheckbox} 0 42u 100% 12u "Install Ollama: free AI models right on this computer"
    ${EndIf}
    Pop $ArtelOllamaBox
    ${If} $ArtelOllama == "1"
      ${NSD_Check} $ArtelOllamaBox
    ${EndIf}

    ${If} ${FileExists} "$LOCALAPPDATA\Programs\Ollama\ollama.exe"
      EnableWindow $ArtelOllamaBox 0
      ${NSD_Uncheck} $ArtelOllamaBox
      ${If} $LANGUAGE == 1049
        ${NSD_CreateLabel} 12u 56u -12u 18u "Ollama уже установлена: Artel найдёт её сам."
      ${Else}
        ${NSD_CreateLabel} 12u 56u -12u 18u "Ollama is already installed: Artel will find it."
      ${EndIf}
    ${Else}
      ${If} $LANGUAGE == 1049
        ${NSD_CreateLabel} 12u 56u -12u 26u "Artel скачает её при первом запуске (около 1 ГБ) и покажет, сколько осталось. Можно и позже: «Локальные модели» в Artel."
      ${Else}
        ${NSD_CreateLabel} 12u 56u -12u 26u "Artel downloads it on its first start (about 1 GB) and shows how much is left. It can wait too: Local models in Artel."
      ${EndIf}
    ${EndIf}
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function ArtelOptionsLeave
    ${NSD_GetState} $ArtelDesktopBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $ArtelNoDesktop "0"
    ${Else}
      StrCpy $ArtelNoDesktop "1"
    ${EndIf}
    ${NSD_GetState} $ArtelOllamaBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $ArtelOllama "1"
    ${Else}
      StrCpy $ArtelOllama "0"
    ${EndIf}
  FunctionEnd
  !macroend

  !macro customInstall
    ${If} $ArtelNoDesktop == "1"
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
    ${EndIf}
    ${If} $ArtelOllama == "1"
      FileOpen $0 "$INSTDIR\install-ollama" w
      FileClose $0
    ${EndIf}
  !macroend
!endif
