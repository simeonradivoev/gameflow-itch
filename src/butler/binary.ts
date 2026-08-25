import fs from 'node:fs/promises';
import path from 'node:path';
import StreamZip from 'node-stream-zip';

const VERSION_FILE = 'current-version';

export function butlerPlatform (platform = process.platform, architecture = process.arch)
{
    const os = ({ win32: 'windows', linux: 'linux', darwin: 'darwin' } as Record<string, string>)[platform];
    const arch = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[architecture];
    if (!os || !arch) throw new Error(`Butler is not available for ${platform}/${architecture}`);
    return `${os}-${arch}`;
}

function executableName (platform = process.platform)
{
    return platform === 'win32' ? 'butler.exe' : 'butler';
}

async function readInstalledBinary (statePath: string)
{
    try
    {
        const version = (await fs.readFile(path.join(statePath, VERSION_FILE), 'utf8')).trim();
        const binary = path.join(statePath, 'versions', version, executableName());
        await fs.access(binary);
        return binary;
    } catch
    {
        return undefined;
    }
}

async function latestVersion (platform: string)
{
    const response = await fetch(`https://broth.itch.zone/butler/${platform}/LATEST`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Could not check Butler version: ${response.status} ${response.statusText}`);
    const version = (await response.text()).trim();
    if (!/^[A-Za-z0-9._+-]+$/.test(version)) throw new Error('Broth returned an invalid Butler version');
    return version;
}

async function installVersion (statePath: string, platform: string, version: string)
{
    const versionPath = path.join(statePath, 'versions', version);
    const binaryPath = path.join(versionPath, executableName());
    try
    {
        await fs.access(binaryPath);
        return binaryPath;
    } catch {}

    const temporaryPath = path.join(statePath, 'downloads', `${version}-${crypto.randomUUID()}`);
    const archivePath = `${temporaryPath}.zip`;
    await fs.mkdir(temporaryPath, { recursive: true });
    try
    {
        const response = await fetch(`https://broth.itch.zone/butler/${platform}/${encodeURIComponent(version)}/archive/default`, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`Could not download Butler: ${response.status} ${response.statusText}`);
        await Bun.write(archivePath, response);

        const zip = new StreamZip.async({ file: archivePath });
        try
        {
            const entries = Object.values(await zip.entries());
            const expectedName = executableName();
            const entry = entries.find(item => !item.isDirectory && item.name.replaceAll('\\', '/') === expectedName);
            if (!entry) throw new Error(`Butler archive does not contain ${expectedName}`);
            await zip.extract(entry.name, path.join(temporaryPath, expectedName));
        } finally
        {
            await zip.close();
        }

        const temporaryBinary = path.join(temporaryPath, executableName());
        if (process.platform !== 'win32') await fs.chmod(temporaryBinary, 0o755);
        const check = Bun.spawn([temporaryBinary, '--version'], { stdout: 'pipe', stderr: 'pipe' });
        const [exitCode, output, errorOutput] = await Promise.all([
            check.exited,
            new Response(check.stdout).text(),
            new Response(check.stderr).text()
        ]);
        if (exitCode !== 0 || !(output.trim() || errorOutput.trim()))
            throw new Error('Downloaded Butler failed its version check: ' + (errorOutput.trim() || output.trim() || ('exit code ' + exitCode)));
        await fs.mkdir(path.dirname(versionPath), { recursive: true });
        await fs.rename(temporaryPath, versionPath);
        return binaryPath;
    } finally
    {
        await fs.rm(archivePath, { force: true });
        await fs.rm(temporaryPath, { recursive: true, force: true });
    }
}

export async function ensureButler (statePath: string)
{
    await fs.mkdir(statePath, { recursive: true });
    const platform = butlerPlatform();
    let version: string;
    try
    {
        version = await latestVersion(platform);
    } catch (error)
    {
        const installed = await readInstalledBinary(statePath);
        if (installed) return installed;
        throw error;
    }

    const binary = await installVersion(statePath, platform, version);
    await fs.writeFile(path.join(statePath, VERSION_FILE), `${version}\n`);
    return binary;
}
