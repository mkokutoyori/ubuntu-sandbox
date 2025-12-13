# Windows Terminal

The NetSim Windows terminal provides a realistic simulation of Windows Command Prompt (CMD) and PowerShell.

## Features

### Dual Shell Support
- **CMD (Command Prompt)**: Windows classic command line
- **PowerShell**: Modern shell with cmdlet support

### Shell Switching
- From CMD: Type `powershell` to enter PowerShell
- From PowerShell: Type `exit` or `cmd` to return to CMD

### Tab Completion
Press Tab to autocomplete file and directory names:
- Works with partial filenames
- Adds `\` for directories
- Handles both absolute and relative paths

## CMD Commands

### Navigation
```cmd
cd [path]         Change directory
dir               List directory contents
md [name]         Create directory
rd [name]         Remove directory (empty)
```

### File Operations
```cmd
type [file]       Display file contents
copy [src] [dst]  Copy file
move [src] [dst]  Move file
del [file]        Delete file
ren [old] [new]   Rename file
```

### System
```cmd
cls               Clear screen
echo [text]       Display text
set               Show environment variables
hostname          Show computer name
systeminfo        System information
```

### Network
```cmd
ipconfig          Network configuration
ping [host]       Ping host
tracert [host]    Trace route
netstat           Network statistics
```

## PowerShell Cmdlets

### File System
```powershell
Get-ChildItem         # ls, dir, gci
Set-Location          # cd, sl
Get-Location          # pwd, gl
Get-Content           # cat, gc, type
Set-Content           # sc
Add-Content           # ac
New-Item              # ni
Remove-Item           # rm, del, ri
Copy-Item             # cp, copy, cpi
Move-Item             # mv, move, mi
Rename-Item           # ren, rni
Test-Path             # Check if path exists
```

### Output
```powershell
Write-Output          # echo, write
Write-Host            # Print to console
Write-Error           # Error message
Write-Warning         # Warning message
Clear-Host            # cls, clear
Out-File              # Write to file
Out-Null              # Discard output
```

### Object Manipulation
```powershell
Select-Object         # select - Choose properties
Where-Object          # where, ? - Filter objects
Sort-Object           # sort - Sort objects
ForEach-Object        # foreach, % - Process each
Measure-Object        # measure - Statistics
Group-Object          # Group by property
Format-Table          # ft - Table format
Format-List           # fl - List format
Format-Wide           # fw - Wide format
```

### String Processing
```powershell
Select-String         # sls - Search text (like grep)
```

### Variables
```powershell
Get-Variable          # List variables
Set-Variable          # Set variable
Remove-Variable       # Remove variable
$var = value          # Direct assignment
```

### Process
```powershell
Get-Process           # ps, gps - List processes
Stop-Process          # kill, spps - Stop process
```

### Help & Info
```powershell
Get-Help              # man, help
Get-Command           # List available commands
Get-Alias             # List aliases
Get-History           # h, history
Get-Date              # Current date/time
```

## Pipeline Support

PowerShell supports piping output between cmdlets:

```powershell
Get-ChildItem | Where-Object { $_.Length -gt 1000 }
Get-Process | Sort-Object CPU -Descending | Select-Object -First 5
Get-ChildItem | Format-Table Name, Length
```

## Built-in Aliases

| Alias | Cmdlet |
|-------|--------|
| ls, dir, gci | Get-ChildItem |
| cd, sl | Set-Location |
| pwd, gl | Get-Location |
| cat, gc, type | Get-Content |
| cp, copy | Copy-Item |
| mv, move | Move-Item |
| rm, del | Remove-Item |
| mkdir, md | New-Item -ItemType Directory |
| cls, clear | Clear-Host |
| echo | Write-Output |
| ps | Get-Process |
| kill | Stop-Process |
| man, help | Get-Help |
| sort | Sort-Object |
| select | Select-Object |
| where, ? | Where-Object |
| foreach, % | ForEach-Object |
| ft | Format-Table |
| fl | Format-List |
| h, history | Get-History |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Tab | Autocomplete path |
| Up Arrow | Previous command |
| Down Arrow | Next command |
| Ctrl+C | Cancel current line |
| Ctrl+L | Clear screen |

## Recent Improvements

### Exit Behavior Fix
- `exit` in PowerShell now returns to CMD instead of closing the terminal
- Consistent with real Windows behavior

### Tab Completion
- File and directory name completion
- Handles paths with backslashes
- Case-insensitive matching
- Adds trailing `\` for directories

## Extending the Terminal

### Adding CMD Commands

1. Edit `src/terminal/windows/commands/[category].ts`
2. Add command function following the pattern:

```typescript
export const myCommand: WindowsCmdFunction = (args, state, fs) => {
  return {
    output: 'result',
    exitCode: 0,
    // Optional:
    // error: 'error message'
    // newPath: 'C:\\new\\path'
    // clearScreen: true
    // switchToPowerShell: true
    // exitTerminal: true
  };
};
```

### Adding PowerShell Cmdlets

1. Edit `src/terminal/windows/powershell/cmdlets.ts`
2. Register cmdlet:

```typescript
registerCmdlet('My-Cmdlet', (args, context, pipelineInput) => {
  // args.positional: positional arguments
  // args.named: named parameters (Map)
  // context: PSContext with fs, variables, etc.
  // pipelineInput: objects from pipeline

  return {
    objects: [/* PSValue objects */],
    exitCode: 0,
    // Optional: newPath
  };
});
```

### PSValue Types

```typescript
psString('text')           // String
psInt(42)                  // Integer
psFloat(3.14)              // Float
psBool(true)               // Boolean
psNull()                   // Null
psArray([...])             // Array
psHashtable(new Map())     // Hashtable
psDateTime(new Date())     // DateTime
```
