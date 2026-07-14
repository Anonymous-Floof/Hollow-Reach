// Export a world to a downloadable .world file (to share with friends) and
// import one back via a file picker. Self-contained — no server or account.

export function exportWorld(save) {
  const safe = (save.name || "world").replace(/[^a-z0-9_-]+/gi, "_");
  const blob = new Blob([JSON.stringify(save)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}.world`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Returns a Promise resolving to the parsed save object.
export function importWorld() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".world,application/json";
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return reject(new Error("no file"));
      const reader = new FileReader();
      reader.onload = () => {
        try { resolve(JSON.parse(reader.result)); }
        catch (e) { reject(e); }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    };
    input.click();
  });
}
