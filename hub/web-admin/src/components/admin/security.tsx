// Sign-in sessions, the password, the recovery password, TOTP.
import { useEffect, useState } from "react"
import { Copy, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import QRCode from "qrcode"

import { ConfirmDialog, Field, copy } from "./shared"
import { useSettings, type Settings } from "./settings"

export type Session = { id: string; current: boolean; created_at: number }

export function Sessions() {
  const [rows, setRows] = useState<Session[] | null>(null)
  const [busy, setBusy] = useState("")

  const load = () => api<Session[]>("/sessions").then(setRows).catch((e: Error) => toast.error(e.message))
  useEffect(() => { load() }, [])

  async function remove(id: string) {
    setBusy(id)
    try {
      await api(`/sessions/${id}`, { method: "DELETE" })
      toast.success("已删除会话")
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  if (!rows) return null
  return (
    <Card className="gap-4 p-5">
      <div>
        <h3 className="text-sm font-medium">登录会话</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          每次登录一条，14 天后过期。删除后该设备下一次请求就被登出。
        </p>
      </div>
      <div className="divide-y">
        {rows.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="tnum">{new Date(s.created_at * 1000).toLocaleString()}</span>
              {s.current && <Badge variant="secondary">当前设备</Badge>}
            </div>
            {/* 当前会话没有删除按钮：右上角的退出登录做的就是这件事，而在这里删
                只会让已经渲染好的面板以为自己还登着。 */}
            {!s.current && (
              <Button size="icon" variant="ghost" disabled={!!busy} onClick={() => remove(s.id)}>
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

export function Security({ siteName }: { siteName: string }) {
  const { s, set, save } = useSettings()
  const [password, setPassword] = useState("")
  const [recovery, setRecovery] = useState("")
  // The TOTP binding flow: begin returns a secret the operator scans or
  // pastes into an authenticator app; confirm proves the app holds the same
  // secret with one live code. Neither step is stored until confirm succeeds.
  const [binding, setBinding] = useState<{ secret: string } | null>(null)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  // The QR of the otpauth:// URI, rendered locally: no third-party image
  // service learns the secret, and dark mode needs the white pad anyway.
  const [qr, setQr] = useState("")
  useEffect(() => {
    if (!binding) return
    const issuer = siteName || "Monitor"
    const uri =
      `otpauth://totp/${encodeURIComponent(issuer)}:admin` +
      `?secret=${binding.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
    let live = true
    QRCode.toDataURL(uri, { margin: 1, width: 180 })
      .then((url) => { if (live) setQr(url) })
      .catch(() => { if (live) setQr("") })
    return () => { live = false }
  }, [binding, siteName])
  if (!s) return null

  async function beginTotp() {
    setBusy(true)
    try {
      const r = await api<{ secret: string }>("/auth/totp")
      setQr("")
      setBinding(r)
      setCode("")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function confirmTotp() {
    if (!binding) return
    setBusy(true)
    try {
      await api("/auth/totp", { method: "PUT", body: JSON.stringify({ secret: binding.secret, code }) })
      toast.success("两步验证已开启")
      setBinding(null)
      // The flag drives the sign-in page's code field; re-read rather than
      // guess, same as every credential flag here.
      const fresh = await api<Settings>("/settings")
      set("totp_set", String(fresh.totp_set))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function disableTotp() {
    setBusy(true)
    try {
      await api("/auth/totp", { method: "DELETE" })
      toast.success("两步验证已关闭")
      set("totp_set", "false")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
      setConfirmOff(false)
    }
  }

  const totpOn = s.totp_set === true

  return (
    <div className="space-y-4">
      <Sessions />

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">两步验证（TOTP）</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            开启后登录需要密码加谷歌验证器等 App 的 6 位验证码。应急密码是不走验证码的后备入口，仅作找回用。
          </p>
        </div>
        {totpOn && !binding && (
          <p className="flex items-center gap-2 text-sm">
            <Badge>已开启</Badge>
            <span className="text-muted-foreground">登录时需要验证码</span>
          </p>
        )}
        {binding ? (
          <div className="space-y-4">
            {/* Both channels: the QR for a phone camera, the bare secret for
                an app that takes one input field. The URI is derived here
                from the site's own name, so the issuer an authenticator shows
                is the name the operator chose. */}
            <div className="flex flex-wrap items-center gap-4">
              {binding && qr ? (
                // A white pad whatever the theme: a QR is dark modules on
                // light ground or it does not scan.
                <div className="rounded-md border p-2">
                  <img src={qr} alt="两步验证二维码" width={180} height={180} />
                </div>
              ) : (
                <div className="grid h-[196px] w-[196px] place-items-center rounded-md border text-xs text-muted-foreground">
                  二维码生成中…
                </div>
              )}
              <p className="max-w-64 text-xs leading-relaxed text-muted-foreground">
                用验证器 App 扫码即可添加；无法扫码时用下方密钥手动输入。
              </p>
            </div>
            <Field
              label="验证器密钥"
              hint="在验证器 App 里选「手动输入密钥」，粘贴这串字符"
            >
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs select-all">
                  {binding.secret}
                </code>
                <Button size="sm" variant="outline" onClick={() => copy(binding.secret)}>
                  <Copy className="size-4" />
                </Button>
              </div>
            </Field>
            <Field label="输入 App 显示的 6 位验证码完成绑定">
              <div className="flex gap-2">
                <Input
                  inputMode="numeric"
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-28 font-mono"
                />
                <Button size="sm" disabled={busy || code.length !== 6} onClick={confirmTotp}>
                  确认开启
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setBinding(null)}>取消</Button>
              </div>
            </Field>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {totpOn ? (
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirmOff(true)}>
                关闭两步验证
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={beginTotp}>
                开启两步验证
              </Button>
            )}
          </div>
        )}
      </Card>

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">密码</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            登录的主密码。修改后其它设备登录立即失效，当前设备不受影响。
          </p>
        </div>
        <Field label="新密码" hint="至少 12 位">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <div>
          <Button
            size="sm"
            disabled={password.length < 12}
            onClick={() => save({ admin_password: password }).then(() => setPassword(""))}
          >
            修改密码
          </Button>
        </div>
      </Card>

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">应急密码</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            丢失验证器时的后备入口：用它可以不输验证码登录（会推送一条登录提醒）。找回后请重新绑定两步验证。留空保存即清除。
          </p>
        </div>
        <Field label={s.emergency_password_set ? "新应急密码（留空保存 = 清除）" : "应急密码"} hint={s.emergency_password_set ? "已设置" : "未设置，建议设置一个以防验证器丢失"}>
          <Input type="password" value={recovery} onChange={(e) => setRecovery(e.target.value)} autoComplete="new-password" />
        </Field>
        <div>
          <Button
            size="sm"
            disabled={recovery.length > 0 && recovery.length < 12}
            onClick={() => save({ emergency_password: recovery }).then(() => setRecovery(""))}
          >
            {recovery ? "保存应急密码" : s.emergency_password_set ? "清除应急密码" : "保存应急密码"}
          </Button>
        </div>
      </Card>

      {confirmOff && (
        <ConfirmDialog
          title="关闭两步验证？"
          description="关闭后登录只需密码。应急密码等所有登录方式都不再要求验证码。"
          confirmLabel="关闭两步验证"
          busy={busy}
          onClose={() => setConfirmOff(false)}
          onConfirm={disableTotp}
        />
      )}
    </div>
  )
}
