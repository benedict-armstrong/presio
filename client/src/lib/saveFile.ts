/** Hand the browser a file to save, as a download named `name`. */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick before revoking; Safari has been finicky.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
