import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

export interface WindowsPipeOwner {
  processId: number;
  ownerIsCurrentUser: boolean;
  executable: string;
  installLocation: string;
  packageFamilyName: string;
  signatureStatus: string;
  signer: string;
}

/** The inspected server is the one on the still-open pipe, not a process found by name. */
export function trustedCodexPipeOwner(owner: WindowsPipeOwner) {
  if (
    !owner ||
    ['executable', 'installLocation', 'packageFamilyName', 'signatureStatus', 'signer'].some(
      (key) => typeof owner[key as keyof WindowsPipeOwner] !== 'string',
    )
  )
    return false;
  const apps = path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');
  return (
    Number.isSafeInteger(owner.processId) &&
    owner.processId > 0 &&
    owner.ownerIsCurrentUser === true &&
    owner.packageFamilyName === 'OpenAI.Codex_2p2nqsd0c76g0' &&
    path.win32
      .resolve(owner.installLocation)
      .toLowerCase()
      .startsWith(apps.toLowerCase() + '\\') &&
    path.win32.resolve(owner.executable).toLowerCase() ===
      path.win32.join(owner.installLocation, 'app', 'ChatGPT.exe').toLowerCase() &&
    owner.signatureStatus === 'Valid' &&
    /(?:^|,\s*)O=(?:"OpenAI OpCo, LLC"|"OpenAI, L\.L\.C\."|OpenAI)(?:,|$)/.test(owner.signer)
  );
}

// Windows PowerShell is present on the supported Windows desktop. Its .NET pipe handle lets
// us verify the exact connected server's SID/package/signature before any IPC frame is sent.
// Keep that handle for the relay; checking a separate connection would leave a replacement race.
function bridgeScript(pipeName: string) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(pipeName)) throw Error('invalid-pipe-name');
  return `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class OfficeCodexPipe {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr handle, out uint pid);
 public static void Relay(Stream pipe) {
   Stream input=Console.OpenStandardInput(), output=Console.OpenStandardOutput();
   if(input.ReadByte()!=71 || input.ReadByte()!=79 || input.ReadByte()!=10) return;
   Task a=input.CopyToAsync(pipe), b=pipe.CopyToAsync(output);
   Task.WaitAny(a,b);
 }
}
'@
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.','${pipeName}',[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous)
try {
 $pipe.Connect(3000)
 [uint32]$serverProcessId=0
 if(-not [OfficeCodexPipe]::GetNamedPipeServerProcessId($pipe.SafePipeHandle.DangerousGetHandle(),[ref]$serverProcessId)){throw 'Cannot identify pipe owner'}
 $server=Get-CimInstance Win32_Process -Filter "ProcessId=$serverProcessId"
 $serverOwner=Invoke-CimMethod -InputObject $server -MethodName GetOwnerSid
 $package=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
 $signature=Get-AuthenticodeSignature -LiteralPath $server.ExecutablePath
 $facts=@{processId=[int]$serverProcessId;ownerIsCurrentUser=($serverOwner.ReturnValue -eq 0 -and $serverOwner.Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value);executable=[string]$server.ExecutablePath;installLocation=[string]$package.InstallLocation;packageFamilyName=[string]$package.PackageFamilyName;signatureStatus=[string]$signature.Status;signer=[string]$signature.SignerCertificate.Subject}
 [Console]::Error.WriteLine(($facts | ConvertTo-Json -Compress))
 [OfficeCodexPipe]::Relay($pipe)
} finally { $pipe.Dispose() }
`;
}

/** Generic only for isolated pipe fixtures; production always supplies the fixed Codex pipe. */
export async function verifiedWindowsPipe(
  pipeName: string,
  validate: (owner: WindowsPipeOwner) => boolean,
  timeout = 6000,
): Promise<Duplex> {
  const shell = path.win32.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const child = spawn(
    shell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(bridgeScript(pipeName), 'utf16le').toString('base64'),
    ],
    {
      windowsHide: true,
      // A pwsh 7 parent can export incompatible Core modules to Windows PowerShell 5.1.
      env: { ...process.env, PSModulePath: path.win32.join(path.win32.dirname(shell), 'Modules') },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let received = '';
      const timer = setTimeout(() => finish(Error('pipe-verification-timeout')), timeout);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stderr.off('data', read);
        child.off('error', failed);
        child.off('exit', exited);
        error ? reject(error) : resolve();
      };
      const failed = () => finish(Error('pipe-verification-failed'));
      const exited = () => finish(Error('pipe-verification-failed'));
      const read = (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (received.length > 16_384) return failed();
        const end = received.indexOf('\n');
        if (end < 0) return;
        try {
          if (!validate(JSON.parse(received.slice(0, end)))) throw Error('untrusted-pipe');
          finish();
        } catch {
          failed();
        }
      };
      child.once('error', failed);
      child.once('exit', exited);
      child.stderr.on('data', read);
    });
    // Metadata travels on stderr. Stdout contains only the original length-prefixed frames.
    // The GO gate is read one byte at a time, so it cannot swallow a coalesced first frame.
    child.stderr.resume();
    const socket = Duplex.from({ readable: child.stdout, writable: child.stdin });
    child.once('error', () => socket.destroy(Error('pipe-disconnected')));
    child.once('exit', () => socket.destroy());
    socket.once('close', () => child.kill());
    child.stdin.write('GO\n');
    return socket;
  } catch (error) {
    child.kill();
    throw error;
  }
}

export function windowsCodexPipe(home: string) {
  // The Windows app uses one fixed pipe, independent of CODEX_HOME. Never attach a temporary
  // test/preview home to the user's real Desktop router.
  const current = path.resolve(os.homedir(), '.codex').toLowerCase();
  if (
    path.resolve(home).toLowerCase() !== current ||
    (process.env.CODEX_HOME && path.resolve(process.env.CODEX_HOME).toLowerCase() !== current)
  )
    throw Error('unsupported-desktop-home');
  return verifiedWindowsPipe('codex-ipc', trustedCodexPipeOwner);
}
