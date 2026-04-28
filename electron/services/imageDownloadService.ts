import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
// import { ConfigService } from './config'

const execFileAsync = promisify(execFile)

export class ImageDownloadService {
  private static instance: ImageDownloadService
  private koffi: any = null
  private lib: any = null
  private initialized = false
  
  private initImgHelper: any = null
  private uninstallImgHelper: any = null
  private getImgHelperError: any = null

  private currentPid: number | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private isHooked = false

  static getInstance(): ImageDownloadService {
    if (!ImageDownloadService.instance) {
      ImageDownloadService.instance = new ImageDownloadService()
    }
    return ImageDownloadService.instance
  }

  private constructor() {
  }

  private async ensureInitialized(): Promise<boolean> {
    if (this.initialized) return true
    if (process.platform !== 'win32' || process.arch !== 'x64') return false

    try {
      this.koffi = require('koffi')
      const dllPath = this.getDllPath()
      if (!existsSync(dllPath)) {
        console.error(`[ImageDownloadService] dll not found: ${dllPath}`)
        return false
      }

      this.lib = this.koffi.load(dllPath)
      this.initImgHelper = this.lib.func('bool InitImgHelper(uint32)')
      this.uninstallImgHelper = this.lib.func('void UninstallImgHelper()')
      this.getImgHelperError = this.lib.func('const char* GetImgHelperError()')
      
      this.initialized = true
      return true
    } catch (error) {
      console.error('[ImageDownloadService] failed to initialize:', error)
      return false
    }
  }

  private getDllPath(): string {
    const isPackaged = app.isPackaged
    const candidates: string[] = []
    
    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'image', 'win32', 'x64', 'img_helper.dll'))
    } else {
      candidates.push(join(process.cwd(), 'resources', 'image', 'win32', 'x64', 'img_helper.dll'))
    }

    for (const path of candidates) {
      if (existsSync(path)) return path
    }
    return candidates[0]
  }

  private async findMainWeChatPid(): Promise<number | null> {
    try {
      const script = `
      Get-CimInstance Win32_Process -Filter "Name = 'Weixin.exe'" | 
      Select-Object ProcessId, CommandLine | 
      ConvertTo-Json -Compress
    `;

      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script])
      if (!stdout || !stdout.trim()) return null

      let processes = JSON.parse(stdout.trim())
      if (!Array.isArray(processes)) processes = [processes]

      const target = processes
          .filter((p: any) => p.CommandLine && p.CommandLine.toLowerCase().includes('weixin.exe'))
          .sort((a: any, b: any) => a.CommandLine.length - b.CommandLine.length)[0]

      return target ? target.ProcessId : null;
    } catch (e) {
      return null
    }
  }

  async startAutoDownload(): Promise<{ success: boolean; error?: string }> {
    if (!await this.ensureInitialized()) {
      return { success: false, error: '核心组件初始化失败，请检查环境' }
    }

    if (this.pollTimer) return { success: true }

    this.pollTimer = setInterval(() => this.checkAndHook(), 30000)
    // 首次尝试 Hook，并返回结果
    return await this.checkAndHook(true)
  }

  async stopAutoDownload() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    await this.unhook()
  }

  private async checkAndHook(isManualStart = false): Promise<{ success: boolean; error?: string }> {
    const pid = await this.findMainWeChatPid()

    if (!pid) {
      if (this.isHooked) {
        console.log('[ImageDownloadService] WeChat exited, unhooking')
        await this.unhook()
      }
      // 如果是手动开启时没找到进程，不认为是严重错误，只是挂起等待
      return { success: true, error: '等待微信启动' }
    }

    if (this.isHooked && this.currentPid === pid) {
      return { success: true }
    }

    if (this.isHooked && this.currentPid !== pid) {
      console.log('[ImageDownloadService] WeChat PID changed, re-hooking')
      await this.unhook()
    }

    console.log(`[ImageDownloadService] attempting to hook PID: ${pid}`)
    try {
      const success = this.initImgHelper(pid)
      if (success) {
        this.isHooked = true
        this.currentPid = pid
        console.log('[ImageDownloadService] hook successful')
        return { success: true }
      } else {
        const err = this.getImgHelperError()
        console.error(`[ImageDownloadService] hook failed: ${err}`)
        // 如果是手动点击开启时失败，停止轮询并向上报错
        if (isManualStart && this.pollTimer) {
          clearInterval(this.pollTimer)
          this.pollTimer = null
        }
        return { success: false, error: err || 'Hook 失败' }
      }
    } catch (e: any) {
      console.error('[ImageDownloadService] InitImgHelper call crashed:', e)
      if (isManualStart && this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
      return { success: false, error: `调用异常: ${e.message || String(e)}` }
    }
  }

  private async unhook() {
    if (this.isHooked && this.uninstallImgHelper) {
      try {
        this.uninstallImgHelper()
      } catch (e) {
        console.error('[ImageDownloadService] uninstall failed:', e)
      }
    }
    this.isHooked = false
    this.currentPid = null
  }

  async getStatus() {
    return {
      isHooked: this.isHooked,
      pid: this.currentPid,
      supported: process.platform === 'win32' && process.arch === 'x64'
    }
  }
}

export const imageDownloadService = ImageDownloadService.getInstance()
