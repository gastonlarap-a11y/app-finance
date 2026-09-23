// Web-build stand-in for '@/services/diagnostics': there is no Go log on the
// iPad, so render errors only go to the console (visible via Safari Web Inspector).
export async function reportRenderError(message: string, stack: string): Promise<void> {
  console.error('render error:', message, stack)
  return Promise.resolve()
}
