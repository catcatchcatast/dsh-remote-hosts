// Public change history: docs/PUBLIC-CHANGES.md
export async function preparePreview(request, signal) {
  const response = await fetch('/api/remote-hosts/file-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, streamResponse: location.protocol === 'dsh-app:' }),
    signal,
  })
  if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`)
  const entry = await response.json()
  if (typeof entry.error === 'string') throw new Error(entry.error)
  return entry
}
