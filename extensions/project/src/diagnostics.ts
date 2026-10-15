import { localize } from "./language.ts"
import { ProjectStorageError } from "./store.ts"

/** Marks copy already rendered in the command's captured language; causes retain diagnostics. */
export class ProjectCommandError extends Error {
  override name = "ProjectCommandError"
}

/** Storage retains machine-readable reasons; localization happens only at the human boundary. */
export function projectError(error: unknown, language: string): string {
  if (error instanceof ProjectCommandError) return error.message
  if (error instanceof ProjectStorageError) {
    const detail = error.details
    if (detail.reason === "stale-revision")
      return localize(
        language,
        error.message,
        `此确认对应的版本已过期：期望版本 ${detail.expectedRevision}，当前版本 ${detail.currentRevision}。请重新运行 /project next，查看最新状态后再次确认。`,
        `この承認のリビジョンは古くなっています。期待値 ${detail.expectedRevision}、現在値 ${detail.currentRevision}。/project next で最新の状態を再確認し、改めて承認してください。`,
      )
    if (detail.reason === "unsupported-schema") {
      const documents: Record<string, [string, string]> = {
        "project marker": ["项目标记", "プロジェクトマーカー"],
        "iteration state": ["迭代状态", "イテレーション状態"],
        "iteration journal": ["迭代日志", "イテレーション履歴"],
        "iteration artifact": ["迭代产物", "イテレーション成果物"],
      }
      const [zh, ja] = documents[detail.document] ?? ["项目数据", "プロジェクトデータ"]
      return localize(
        language,
        error.message,
        `${zh}的格式版本 ${detail.encountered} 不受支持；当前支持版本 ${detail.supported}。请使用兼容的扩展，不要删除或重写已有证据。`,
        `${ja}の形式バージョン ${detail.encountered} には対応していません。対応バージョンは ${detail.supported} です。互換性のある拡張を使用し、既存の証拠を削除・書き換えないでください。`,
      )
    }
    if (detail.reason === "transition-rejected")
      return localize(
        language,
        error.message,
        "当前阶段不允许此操作。请运行 /project status 查看状态，使用 /project next 确认或取消待定方案后重试。已有工作和证据均保留。",
        "現在の段階ではこの操作を行えません。/project status で状態を確認し、/project next で保留中の提案を承認または取り消してから再試行してください。既存の作業と証拠は保持されています。",
      )
    if (detail.reason === "malformed-storage")
      return localize(
        language,
        error.message,
        "项目数据格式无效，无法读取。请保留已有文件和手动修改，并检查或恢复有效副本；不要通过删除证据来重试。",
        "プロジェクトデータの形式が無効で読み取れません。既存のファイルと手動変更を保持し、有効なコピーを確認・復元してください。証拠を削除して再試行しないでください。",
      )
    if (detail.reason === "hash-mismatch")
      return localize(
        language,
        error.message,
        "项目日志的校验链不匹配。请保留已有证据并检查有效备份；不要删除或重写日志。",
        "プロジェクト履歴の検証チェーンが一致しません。既存の証拠を保持して有効なバックアップを確認し、履歴を削除・書き換えないでください。",
      )
    switch (error.code) {
      case "missing":
        return localize(
          language,
          error.message,
          "项目文件缺失或已移动。请恢复原目录，或用 /project switch 明确选择项目；未关联任何替代项目。",
          "プロジェクトファイルが見つからないか移動されています。元のディレクトリを復元するか /project switch で明示的に選択してください。別のプロジェクトには切り替えていません。",
        )
      case "replaced":
        return localize(
          language,
          error.message,
          "项目、目录或迭代身份已改变。已停止操作；请检查原项目并用 /project switch 重新选择。未重写已有证据。",
          "プロジェクト、ディレクトリ、またはイテレーションの識別情報が変わりました。操作を停止しました。元のプロジェクトを確認し /project switch で選び直してください。証拠は書き換えていません。",
        )
      case "unsafe":
        return localize(
          language,
          error.message,
          "无法安全访问项目文件，已拒绝操作。请检查路径、符号链接和文件系统支持；不要删除已有证据。",
          "プロジェクトファイルに安全にアクセスできないため、操作を拒否しました。パス、シンボリックリンク、ファイルシステムの対応状況を確認し、既存の証拠は削除しないでください。",
        )
      case "invalid":
        return localize(
          language,
          error.message,
          "项目数据或当前请求无效，操作无法完成。请运行 /project status 检查当前状态，再重新确认；保留已有证据和手动修改。",
          "プロジェクトデータまたは現在の要求が無効なため、操作を完了できません。/project status で状態を確認し、改めて承認してください。既存の証拠と手動変更を保持してください。",
        )
    }
  }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return localize(
      language,
      error instanceof Error ? error.message : String(error),
      `项目文件操作失败（${error.code}）。请检查文件是否可访问、权限和剩余磁盘空间，再重试。`,
      `プロジェクトのファイル操作に失敗しました（${error.code}）。ファイルへのアクセス、権限、ディスクの空き容量を確認して再試行してください。`,
    )
  const category = error instanceof Error ? error.name : "unknown"
  return localize(
    language,
    error instanceof Error ? error.message : String(error),
    `项目操作无法完成（${category}）。请运行 /project status 查看状态，并检查项目及保存的会话文件；保留已有证据。`,
    `プロジェクトの操作を完了できません（${category}）。/project status で状態を確認し、プロジェクトと保存済み会話のファイルを調べてください。既存の証拠を保持してください。`,
  )
}
