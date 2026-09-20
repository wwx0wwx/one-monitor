import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/lib/api"

export function Login({ totp, onDone }: { totp: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError("")
    try {
      await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ password, ...(totp ? { code } : {}) }),
      })
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-svh place-items-center p-6">
      <Card className="w-full max-w-sm gap-5 p-6">
        <h1 className="text-lg font-semibold">登录后台</h1>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-xs">
              密码<span className="text-muted-foreground">（忘记验证器时可用应急密码登录）</span>
            </Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </div>
          {totp && (
            <div className="space-y-1.5">
              <Label htmlFor="code" className="text-xs">两步验证码</Label>
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6 位数字"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </div>
          )}
          <Button type="submit" className="w-full" disabled={busy || !password || (totp && code.length !== 6)}>
            登录
          </Button>
        </form>
      </Card>
    </div>
  )
}
