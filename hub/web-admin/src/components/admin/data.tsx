// The database page: backup, restore, vacuum, retention.
import { useEffect, useRef, useState } from "react"
import { Download, RefreshCw, Upload } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api, download, lastChunkOffset, restoreOutcome, upload } from "@/lib/api"
import { bytes } from "@/lib/format"

import { ConfirmDialog, Field } from "./shared"
import { SettingsStatus, useSettings } from "./settings"

export type DbInfo = {
  path: string
  size: number
  wal: number
  free: number
  /** Timestamp of the earliest history row, null on a database with none. */
  oldest: number | null
  retention: number
  retention_ping: number
  rows: Record<string, number>
}

// The only two tables whose row count indicates anything about size. Every other
// holds one row per node or per key.
export const DB_ROWS: [string, string][] = [
  ["metric", "历史明细"],
  ["ping_record", "延迟记录"],
]

export function Data() {
  const [info, setInfo] = useState<DbInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const { s, err: settingsErr, reload, set, save } = useSettings()
  const [busy, setBusy] = useState("")
  const [confirm, setConfirm] = useState<"vacuum" | null>(null)
  const [pending, setPending] = useState<File | null>(null)
  const [sent, setSent] = useState(0)
  // The last piece has been sent: the hub applies the backup as soon as it
  // lands, so from here on there is no "cancel", only waiting for the answer.
  const [restoring, setRestoring] = useState(false)
  // The hub refused the last upload because the backup fails the checksum it was
  // taken with, and copied nothing. Holds what it said, and keeps the dialog
  // open asking whether to restore the file regardless.
  const [mismatch, setMismatch] = useState<string | null>(null)
  // Closing the dialog must stop the upload rather than merely hide it: restore
  // is the one irreversible action here, and it takes minutes on a large
  // backup.
  const abort = useRef<AbortController | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const load = () =>
    api<DbInfo>("/db")
      .then((d) => { setInfo(d); setErr(null) })
      .catch((e: Error) => {
        toast.error(e.message)
        setErr(e.message || "网络错误")
      })
  useEffect(() => { load() }, [])
  // Leaving the section mid-upload must abort it: without this the chunks keep
  // flying after the dialog they belonged to is gone, and the last one would
  // still trigger the restore the operator walked away from.
  useEffect(() => () => abort.current?.abort(), [])

  // Not the browser's own download (<a href>) any more: that link sat outside
  // every fetch here, with no timeout and no 401 handling -- a proxy that hangs
  // the request left a button that silently did nothing. Same route as api(),
  // then a blob and a synthetic click.
  async function backup() {
    setBusy("backup")
    try {
      const res = await download("/db/backup")
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement("a")
      a.href = url
      // A blob download never sees the response's Content-Disposition, so the
      // file is named here, after the day it was taken.
      a.download = `monitor-${new Date().toISOString().slice(0, 10)}.db`
      a.click()
      // Revoked a beat later, not on the next line: the download has only
      // STARTED at click, and a browser that has not taken its snapshot of the
      // blob yet would abort on an already-dead URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  async function vacuum() {
    setBusy("vacuum")
    try {
      const { pruned, freed } = await api<{ pruned: number; freed: number }>("/db/vacuum", { method: "POST" })
      toast.success(`已清理 ${pruned} 行，回收 ${bytes(freed)}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
      setConfirm(null)
    }
  }

  // `insist` is the operator's answer to a backup that failed its own
  // checksum: the hub then restores that same file without holding it to one.
  async function restore(file: File, insist = false) {
    setBusy("restore")
    setSent(0)
    setRestoring(false)
    setMismatch(null)
    abort.current = new AbortController()
    // The last piece is the one the hub applies the backup on. From the moment
    // it is sent, what this tab does next decides nothing -- a close or a
    // timeout in between used to be reported as "cancelled, nothing changed"
    // about a database that had just been replaced -- so the dialog stops
    // offering a cancel here rather than when the answer arrives. Held in a
    // local as well as in `restoring`: that is state, and inside the failure
    // path below it still holds the value from before the upload.
    const lastAt = lastChunkOffset(file.size)
    let finalSent = false
    const finalPiece = () => {
      finalSent = true
      setRestoring(true)
    }
    // A backup that fits in one piece is applied by its very first request.
    if (lastAt === 0) finalPiece()
    // Whether the dialog stays open afterwards to ask about the checksum.
    let askAgain = false
    try {
      await upload(
        insist ? "/db/restore?force=true" : "/db/restore",
        file,
        (n) => {
          setSent(n)
          if (n === lastAt) finalPiece()
        },
        abort.current.signal,
      )
      // Every chunk has landed; the hub is replacing the database right now.
      // Cancelling stops meaning anything from this point, so the dialog says
      // so instead of offering a button that lies.
      setRestoring(true)
      toast.success("已恢复，正在重新加载")
      // Every node, setting and session on the page came from the database just
      // replaced.
      setTimeout(() => location.reload(), 800)
    } catch (e) {
      // Up to the last piece the hub applies nothing, so a stop there leaves
      // the original database in place. From the last piece on, only the hub's
      // answer says what happened -- and without one, nothing here can.
      const outcome = restoreOutcome(finalSent, e)
      // The hub found the backup changed since it was taken and copied
      // nothing. Not the hub's decision to make for good: the file may be the
      // only copy there is. So the dialog stays, says what was found, and
      // offers to send the same file again with the answer. It takes the place
      // of a toast: a warning that scrolls away would leave a refused restore
      // looking like a failure.
      askAgain = outcome.tone === "mismatch"
      if (askAgain) {
        setMismatch(outcome.text)
        // Nothing is in progress any more -- the hub refused and stopped --
        // so the dialog can be closed again, which it could not while the
        // answer to the upload was still awaited.
        setRestoring(false)
      } else if (outcome.tone === "info") toast.info(outcome.text)
      else toast.error(outcome.text)
      setBusy("")
    }
    if (!askAgain) setPending(null)
  }

  // The page's own three states: loading, error with a retry, the data. A
  // silent null used to read as an empty database page.
  if (!info) {
    return err ? (
      <div className="space-y-3 text-center text-sm">
        <p role="alert" className="text-destructive">加载失败：{err}</p>
        <Button size="sm" variant="outline" onClick={load}>
          <RefreshCw /> 重试
        </Button>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground">加载中…</p>
    )
  }
  const stat = (label: string, value: string) => (
    <div key={label}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tnum mt-0.5 text-sm">{value}</div>
    </div>
  )

  return (
    <div className="space-y-4">
      <Card className="gap-4 p-5">
        <h3 className="text-sm font-medium">数据库</h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {stat("文件大小", bytes(info.size))}
          {stat("预写日志", bytes(info.wal))}
          {stat("可回收空间", bytes(info.free))}
          {stat("服务器数据保留", `${info.retention} 天`)}
          {stat("延迟数据保留", `${info.retention_ping} 天`)}
          {/* 和保留天数并排：跨度小于保留期是还没攒够，大于保留期就是每小时
              那次 prune 没在跑。 */}
          {stat("历史跨度", info.oldest ? `${Math.floor((Date.now() / 1000 - info.oldest) / 86400)} 天` : "—")}
          {DB_ROWS.map(([key, label]) => stat(label, (info.rows[key] ?? 0).toLocaleString()))}
        </div>
        <p className="truncate text-xs text-muted-foreground" title={info.path}>
          <code>{info.path}</code>
        </p>
      </Card>

      {s ? (
        <Card className="gap-4 p-5">
          <div>
            <h3 className="text-sm font-medium">历史数据保留</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              两类明细各自保留这么多天，超出部分在每小时的清理中删除。累计流量不受影响。
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="服务器数据（天）" hint="CPU / 内存 / 网络等指标明细">
              <Input
                type="number"
                value={String(s.retention_metrics_days ?? "7")}
                onChange={(e) => set("retention_metrics_days", e.target.value)}
                placeholder="7"
              />
            </Field>
            <Field label="延迟检测数据（天）" hint="各监控目标的探测记录">
              <Input
                type="number"
                value={String(s.retention_ping_days ?? "7")}
                onChange={(e) => set("retention_ping_days", e.target.value)}
                placeholder="7"
              />
            </Field>
          </div>
          <div>
            <Button
              size="sm"
              onClick={() =>
                save({
                  retention_metrics_days: String(s.retention_metrics_days || "7"),
                  retention_ping_days: String(s.retention_ping_days || "7"),
                })
              }
            >
              保存保留设置
            </Button>
          </div>
        </Card>
      ) : (
        // Where the retention card would be, the reason it is not.
        <SettingsStatus s={s} err={settingsErr} reload={reload} />
      )}

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">回收空间</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            按保留天数清掉过期明细，再重建数据库文件把空出来的页还给磁盘（SQLite 的 VACUUM）。
            重建期间需要与数据库等量的空闲磁盘，过程中面板和上报会短暂变慢。
          </p>
        </div>
        <div>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setConfirm("vacuum")}>
            {busy === "vacuum" ? "回收中…" : "立即回收"}
          </Button>
        </div>
      </Card>

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">备份</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            导出的是整个数据库，含服务器凭证与登录密码哈希，请当作密钥保管。恢复会用备份文件整体覆盖当前数据，
            当前服务器、设置、历史全部作废，所有设备需要重新登录。
            <br />
            请用这里导出的文件恢复：直接复制 <code>monitor.db</code> 会丢掉预写日志里还没落盘的那部分。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy === "backup"} onClick={backup}>
            <Download /> {busy === "backup" ? "导出中…" : "导出备份"}
          </Button>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => picker.current?.click()}>
            <Upload /> 导入备份
          </Button>
          <input
            ref={picker}
            type="file"
            accept=".db,application/octet-stream"
            className="hidden"
            onChange={(e) => {
              setPending(e.target.files?.[0] ?? null)
              e.target.value = ""
            }}
          />
        </div>
      </Card>

      {confirm === "vacuum" && (
        <ConfirmDialog
          title="回收空间？"
          description="超出保留天数的历史明细会被删除，然后重建数据库文件。累计流量不受影响。"
          confirmLabel="开始回收"
          busy={!!busy}
          onClose={() => setConfirm(null)}
          onConfirm={vacuum}
        />
      )}
      {pending && (
        <ConfirmDialog
          title={mismatch ? "备份文件对不上它自带的校验值，仍要恢复？" : "用备份覆盖当前数据？"}
          description={
            mismatch
              ? `这个备份在导出时记下了自己内容的校验值，和现在的内容对不上：文件在导出之后变过——存放时损坏，或者被改动。刚才没有恢复任何东西。仍然恢复，就会把这份可能有错的数据覆盖到当前数据库上，且无法撤销；如果还有别的备份，建议换一份。 hub 的原话：${mismatch}`
              : `将用 ${pending.name}（${bytes(pending.size)}）整体替换当前数据库。当前的服务器、设置和历史全部丢失，且无法撤销。`
          }
          confirmLabel={
            busy === "restore" ? `已上传 ${bytes(sent)} / ${bytes(pending.size)}` : mismatch ? "仍然恢复" : "确认恢复"
          }
          // While earlier pieces are still going up, cancelling stays possible
          // the dialog's own way (Esc / clicking outside, which runs onClose);
          // once the last piece has been sent the cancel button says so and stops.
          cancelLabel={restoring ? "正在恢复，不可取消" : "取消"}
          busy={!!busy}
          onClose={() => {
            if (restoring) return
            abort.current?.abort()
            setPending(null)
            setMismatch(null)
          }}
          onConfirm={() => restore(pending, mismatch !== null)}
        />
      )}
    </div>
  )
}
