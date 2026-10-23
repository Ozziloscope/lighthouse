# Running Lighthouse on Windows

Good for trying Lighthouse out, or for a small team on your own network. For a desk the whole team depends on, a Linux server ([LINUX-SERVER.md](LINUX-SERVER.md)) is still the better home.

## 1. Install Node.js (once)

In PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

Close PowerShell and open a new window, then check that `node -v` prints **v22.13 or newer**.

## 2. Unzip and start

1. Right-click `lighthouse.zip`, choose **Extract All…**, and extract to `C:\Lighthouse`.
2. Open `C:\Lighthouse\lighthouse\windows` and double-click **start-lighthouse.cmd**.
3. The window prints a **setup code**. Open <http://localhost:3000>, enter the code, and create your Administrator account.

Keep the window open while Lighthouse is in use. **Ctrl+C** stops it. Data is saved in `C:\Lighthouse\lighthouse\data\lighthouse.db`.

### Why it shows as lighthouse.exe

Task Manager names a process after its program file, so a Node app normally shows up as `node.exe`. The start script copies your installed `node.exe` to `runtime\lighthouse.exe` and runs the server with that copy. The copy is refreshed automatically after Node.js upgrades, and it keeps Node's digital signature.

- **Details** tab: `lighthouse.exe`.
- **Processes** tab: the console window is titled "lighthouse". Task Manager may still show the description "Node.js JavaScript Runtime", which is built into the program file.
- **Windows Firewall:** if it asks about `lighthouse.exe`, allow **Private networks** only, or choose Cancel if only this PC will use Lighthouse.

## Settings

Copy `deploy\lighthouse.env.example` to `C:\Lighthouse\lighthouse\lighthouse.env` and edit it in Notepad. The start script loads it automatically. For a desk only this PC uses, set:

```ini
HOST=127.0.0.1
PORT=3000
TZ=America/Chicago
```

Every setting is explained in the [README](../README.md#configuration). Email and text alerts are set up as described in [ALERTS.md](ALERTS.md).

## Starting automatically with Windows

Use Task Scheduler so Lighthouse runs even when nobody is signed in:

1. Open **Task Scheduler** and choose **Create Task…** (not "Basic Task").
2. On the **General** tab:
   - Name: `Lighthouse`.
   - Select **Run whether user is logged on or not**.
3. On the **Triggers** tab, add **At startup**.
4. On the **Actions** tab, add **Start a program**:
   - Program: `powershell.exe`
   - Arguments: `-NoProfile -ExecutionPolicy Bypass -File "C:\Lighthouse\lighthouse\windows\start-lighthouse.ps1"`
5. On the **Settings** tab:
   - Clear **Stop the task if it runs longer than**.
   - Set **If the task fails, restart every** to 1 minute.
6. Click OK and enter your Windows password.

Restart the PC, or right-click the task and choose **Run**. `lighthouse.exe` should then appear in Task Manager's **Details** tab.

## Everyday commands

Run these in PowerShell from `C:\Lighthouse\lighthouse`:

| Task | Command |
|---|---|
| Back up | `npm run backup -- C:\Backups\lighthouse.db` |
| Locked out | `npm run reset-password -- <username> "NewTempPass123" --admin` |
| Run the tests | `npm test` |

The file `data\lighthouse.key` encrypts the mail and Twilio passwords you enter under Settings → Alert setup. Backups don't include it. Keep a copy somewhere safe, or re-enter those passwords after restoring on a different PC.

Files attached to tickets are in `data\attachments`. `npm run backup` copies only the database, so copy that folder too (for example with File Explorer, or `robocopy data\attachments C:\Backups\attachments /MIR`).

To restore from a backup:

1. Stop Lighthouse (end `lighthouse.exe` or stop the scheduled task).
2. Replace `data\lighthouse.db` with the backup, and delete any `lighthouse.db-wal` and `lighthouse.db-shm` files beside it.
3. Start Lighthouse again.

## Upgrading

1. Back up first.
2. Stop Lighthouse.
3. Extract the new zip over the old folder. Your `data` folder and `lighthouse.env` are kept.
4. Start Lighthouse again. Database changes apply automatically.
