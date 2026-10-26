// Chargé de façon bloquante dans <head> : applique le thème choisi avant le premier rendu.
try {
  const theme = localStorage.getItem("zo-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // Stockage indisponible : on suit le thème du système.
}
