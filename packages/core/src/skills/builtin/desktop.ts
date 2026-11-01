/** Drimvox's own skills for desktop apps in C# and Java (docs/specs/catalog.md, asked for): each a SKILL.md. */

export const DOTNET = `---
name: dotnet-desktop
description: "When building a Windows desktop app in C#: WPF, WinForms or WinUI 3 with MVVM, tests, and checking the running window"
---

# Desktop apps in C# (.NET)

## Before starting

Call \`dev_environment\`: a .NET SDK 8 or newer is needed (\`winget install Microsoft.DotNet.SDK.8\`). Pick the kind:

- **WPF** — the default for a new Windows app: mature, XAML, data binding, any look. \`dotnet new wpf -n App\`
- **WinForms** — quick forms and internal tools, a designer, little code. \`dotnet new winforms -n App\`
- **WinUI 3** — the modern Windows 11 look (Fluent), packaged as MSIX; needs the Windows App SDK templates
  (\`dotnet new install Microsoft.WindowsAppSDK.Templates\`).
- Must it run on macOS or Linux too? Then not these: use the Avalonia skill.

## Structure (WPF with MVVM)

\`\`\`
App.sln
src/App/            Views/*.xaml, ViewModels/*.cs, Models/, Services/, App.xaml
tests/App.Tests/    xUnit: view models and services, no windows
\`\`\`

- \`CommunityToolkit.Mvvm\`: \`[ObservableProperty]\`, \`[RelayCommand]\` instead of hand-written INotifyPropertyChanged.
- Views only bind (\`{Binding Name}\`, \`Command="{Binding SaveCommand}"\`); logic lives in view models, which are tested.
- Services behind interfaces, given through \`Microsoft.Extensions.DependencyInjection\` set up in \`App.xaml.cs\`.
- Data: SQLite with \`Microsoft.EntityFrameworkCore.Sqlite\` or Dapper; the file in
  \`Environment.GetFolderPath(SpecialFolder.LocalApplicationData)\`/App, never next to the .exe.
- Long work with \`async\`/\`await\`, never blocking the UI thread; errors shown to the user, written to a log.
- Every control a user acts on gets \`AutomationProperties.Name\` (and \`x:Name\`): screen readers and the checks below
  find it by that.
- High DPI: \`<ApplicationHighDpiMode>PerMonitorV2</ApplicationHighDpiMode>\` (WinForms) — WPF handles it itself.

## Check it really works

1. \`dotnet build\` and \`dotnet test\` — both clean, no warnings left unexplained.
2. Start it: \`app_launch\` with \`dotnet\` and \`["run", "--project", "src/App"]\` (or the built .exe in
   \`src/App/bin/Debug/net8.0-windows/\`).
3. \`app_read\` the window: every field and button is there with a name; \`app_type\` into fields, \`app_click\` the
   buttons, \`app_read\` again to see the result; \`app_screenshot\` with a question to judge the look.
4. Try the bad paths too: empty fields, wrong input, no file, no network.
5. \`app_close\` when done.

## Ship

\`dotnet publish src/App -c Release -r win-x64 --self-contained -p:PublishSingleFile=true\` gives one .exe that needs no
.NET installed. For an installer, the desktop installers skill.
`;

export const AVALONIA = `---
name: avalonia
description: "When a C# desktop app must run on Windows, macOS and Linux: Avalonia UI with MVVM, tests and publishing for each system"
---

# Cross-platform desktop apps in C# (Avalonia)

Avalonia is WPF-like XAML that runs on Windows, macOS and Linux (and in the browser). Choose it when the app is not only
for Windows; for Windows alone, WPF is simpler.

## Start

\`\`\`
dotnet new install Avalonia.Templates
dotnet new avalonia.mvvm -n App
\`\`\`

The template brings \`CommunityToolkit.Mvvm\` (or ReactiveUI) and a ViewLocator that pairs \`MainWindowViewModel\` with
\`MainWindow\`.

## Rules

- XAML files are \`.axaml\`; styles are CSS-like selectors (\`<Style Selector="Button.primary">\`), themes are
  \`FluentTheme\` or \`SimpleTheme\`. Compiled bindings: \`x:DataType\` on views, \`x:CompileBindings="True"\`.
- No Windows-only APIs (registry, WinForms dialogs, \`System.Drawing\`): use Avalonia's \`StorageProvider\` for file
  dialogs, \`TopLevel.Clipboard\`, and paths from \`Environment.SpecialFolder\` with \`Path.Combine\`.
- Logic in view models, tested with xUnit; UI tests with \`Avalonia.Headless.XUnit\` (windows without a screen).
- Set \`AutomationProperties.Name\` on controls: Avalonia exposes UI Automation on Windows, so \`app_read\`,
  \`app_click\` and \`app_type\` work on it, as do screen readers.

## Check

\`dotnet build\`, \`dotnet test\`, then \`app_launch\` (\`dotnet run --project App\`) and go through the window with
\`app_read\` / \`app_click\` / \`app_type\` / \`app_screenshot\` on Windows.

## Publish for each system

\`\`\`
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
dotnet publish -c Release -r linux-x64 --self-contained
dotnet publish -c Release -r osx-arm64 --self-contained
\`\`\`

A macOS build needs an .app bundle (Info.plist, icon) and, to open without warnings, signing and notarization on a Mac.
Linux: an AppImage or a .deb. See the desktop installers skill.
`;

export const JAVA = `---
name: java-desktop
description: "When building a desktop app in Java: JavaFX (or Swing) with Gradle, MVC, tests, and a check of the running window"
---

# Desktop apps in Java

## Before starting

Call \`dev_environment\`: a JDK 21 is needed (\`winget install EclipseAdoptium.Temurin.21.JDK\`). Use the Gradle wrapper
(\`gradlew\`) so the project builds without Gradle installed.

- **JavaFX** — the default for a new app: FXML, CSS styling, charts, media; runs on Windows, macOS and Linux.
- **Swing** — built into the JDK, for small tools or extending an old app; FlatLaf makes it look current.

## JavaFX project (Gradle)

\`\`\`groovy
plugins { id 'application'; id 'org.openjfx.javafxplugin' version '0.1.0' }
javafx { version = '21'; modules = ['javafx.controls', 'javafx.fxml'] }
application { mainClass = 'app.Main' }
dependencies { testImplementation 'org.junit.jupiter:junit-jupiter:5.10.2'; testImplementation 'org.testfx:testfx-junit5:4.0.18' }
\`\`\`

\`\`\`
src/main/java/app/     Main.java, controllers/, model/, service/
src/main/resources/app/ *.fxml, styles.css
src/test/java/app/      JUnit 5 for model and services; TestFX for windows
\`\`\`

## Rules

- Views in FXML, a controller per view, logic in model and service classes that are tested without a window.
- Never block the JavaFX thread: long work in a \`Task\` on an executor, results back with \`Platform.runLater\`.
- Data in the user's folder (\`System.getProperty("user.home")\` + \`/.app\`), SQLite through JDBC (\`org.xerial:sqlite-jdbc\`).
- Text through a \`ResourceBundle\` when there is more than one language; UTF-8 everywhere (\`-Dfile.encoding=UTF-8\`).
- Give controls an accessible name (\`setAccessibleText\`): JavaFX exposes UI Automation on Windows, so screen readers
  and \`app_read\` see them. Swing does not (it uses the Java Access Bridge): check Swing windows by \`app_screenshot\`.

## Check

\`gradlew test\`, then \`app_launch\` with \`gradlew.bat\` and \`["run"]\` (wait longer the first time), and go through
the window: \`app_read\`, \`app_type\`, \`app_click\`, \`app_screenshot\` with a question.

## Ship

\`gradlew jlink\` or \`jpackage\` makes a build with its own Java inside — see the desktop installers skill. Swing or a
library: \`gradlew jar\` with the dependencies (the Shadow plugin) for \`java -jar\`.
`;

export const INSTALLERS = `---
name: desktop-installers
description: "When a desktop app must be given to people: installers for Windows (MSIX, WiX, Inno Setup), macOS and Linux, for .NET and Java"
---

# Installers for desktop apps

## Pick

| What | Windows | macOS | Linux |
| --- | --- | --- | --- |
| .NET (WPF, WinForms) | Inno Setup or WiX (.exe/.msi), MSIX | — | — |
| WinUI 3 | MSIX (built in) | — | — |
| Avalonia | Inno Setup / WiX | .app in a .dmg | AppImage, .deb |
| Java | \`jpackage\` (.msi / .exe) | \`jpackage\` (.dmg / .pkg) | \`jpackage\` (.deb / .rpm) |

Start from a self-contained build (no .NET or Java needed on the user's computer):
\`dotnet publish -c Release -r win-x64 --self-contained\`, or for Java a runtime from \`jlink\` that \`jpackage\` adds.

## Inno Setup (the simplest .exe installer)

\`winget install JRSoftware.InnoSetup\`, then a \`setup.iss\`: \`AppName\`, \`AppVersion\`, \`AppId\` (a GUID that never
changes, so updates replace the old version), \`DefaultDirName={autopf}\\App\`, \`[Files]\` from the publish folder,
\`[Icons]\` for the Start menu and an optional desktop shortcut, \`[Run]\` to start after install. Build:
\`ISCC setup.iss\`.

## WiX (an .msi, for companies and Group Policy)

\`dotnet tool install --global wix\`, a \`Package.wxs\` with \`UpgradeCode\` fixed for good and \`MajorUpgrade\`, then
\`wix build Package.wxs\`. Harvest the publish folder rather than listing files by hand.

## MSIX

For WinUI 3 it comes with the project (\`dotnet publish\` with \`-p:GenerateAppxPackageOnBuild=true\`). It needs a
signing certificate; a self-made one works only after the user trusts it, so for strangers buy a code-signing
certificate or publish through the Microsoft Store.

## jpackage (Java)

\`jpackage --type msi --name App --app-version 1.0.0 --input build/libs --main-jar app.jar --main-class app.Main
--win-menu --win-shortcut --win-upgrade-uuid <fixed uuid> --icon app.ico\`. On Windows it needs WiX installed; it
builds only for the system it runs on.

## Always

- An icon (.ico for Windows with 16–256 px, .icns for macOS); the version taken from one place in the project.
- Sign the installer and the .exe (\`signtool sign /fd SHA256 /tr <timestamp server> /td SHA256\`): unsigned ones get
  the SmartScreen warning. macOS needs signing and notarization, done on a Mac.
- Test on a clean machine (Windows Sandbox: \`WindowsSandbox.exe\`): install, start, update over the old version,
  uninstall — nothing left behind except the user's data, if they chose to keep it.
`;
