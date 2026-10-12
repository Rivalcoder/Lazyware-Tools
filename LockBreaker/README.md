# Windows "Folder / File In Use" All-In-One Unlocker & Force Deletion Tool

A native Windows automation solution to permanently fix the error:
> **"Folder In Use — The action can't be completed because the folder or a file in it is open in another program"**

---

## 🛠️ What Causes This Issue?
In Windows, a folder or file cannot be deleted, moved, or renamed if:
1. **File Handle Lock**: A running program (e.g., VS Code, Git, Python, Node.js, Office, browser) has open file handles inside the folder.
2. **Current Working Directory (CWD) Lock**: A terminal, command prompt (`cmd.exe`), PowerShell, or developer tool is currently navigated (`cd`) into the folder.
3. **Windows Explorer Lock**: Windows File Explorer itself or a shell thumbnail generator (`dllhost.exe`, `explorer.exe`) is holding onto the folder.
4. **File Attributes**: Files are marked with `Read-Only`, `System`, or `Hidden` flags.

---

## 🚀 How to Use (Everything in `UnlockFolder.bat`)

### 1. Drag and Drop onto `UnlockFolder.bat`
* Simply **drag and drop** any stubborn folder (e.g., `BurnAndBuild-master`) or file directly onto `UnlockFolder.bat`.
* It immediately loads the target and gives you instant options (Scan, Unlock, or Force Delete).

### 2. Right-Click in Windows Explorer (Already Installed!)
Right-click **any folder, file, drive, or folder background** in Windows Explorer to see:
- 🔓 **`Unlock (Release Locks)`**: Releases all file handles, kernel locks (e.g. adb, sihost), and terminates locking processes without deleting the item. Great for when you need to rename, edit, or move a file.
- 🗑️ **`Unlock & Force Delete`**: Executes the robust 8-phase removal process: terminates locking processes, restarts shell locks, force-closes kernel handles, strips read-only/system flags, wipes mirror contents, and guarantees deletion.
- 🔍 **`Check Locking Programs`**: Scans and displays exactly which processes (PIDs, executables, window titles, handle paths) are locking the target without touching anything.

### 3. Double-Click `UnlockFolder.bat`
1. Double-click `UnlockFolder.bat`.
2. Enter or paste the path of the folder.
3. Select an action from the menu:
   - `[1] Scan - Show user-mode locking processes`
   - `[2] Deep Scan - Enumerate ALL kernel handles (Admin)`
   - `[3] Unlock Only - Kill locking processes & close handles, no delete`
   - `[4] Unlock & Force Delete (full 8-phase)`
   - `[5] Restart Windows Explorer`
   - `[6] Add to Windows Right-Click Context Menu`
   - `[7] Remove from Windows Right-Click Context Menu`

---

## 📁 Files in This Folder
- **`UnlockFolder.bat`**: The all-in-one launcher supporting drag-and-drop, context menus, and interactive CLI.
- **`UnlockFolder.ps1`**: The complete PowerShell engine combining Restart Manager API, PEB CWD detection, and kernel handle scanner (`ntdll.dll`).
- **`LockDetector.dll`**: Precompiled native Win32 library for instant lock detection (optional optimization; engine falls back to built-in code if absent).
