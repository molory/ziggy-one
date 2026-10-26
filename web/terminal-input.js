// @ts-check
// Un message écrit hors du terminal (onglet Discussion), tel qu'on le taperait dans Claude Code.

/**
 * Touches à envoyer pour taper `text` (sans l'Entrée finale) : chaque saut de ligne devient Échap+Entrée,
 * le retour à la ligne de Claude Code (Maj+Entrée du terminal). Les caractères de contrôle sont retirés : un
 * message ne peut pas glisser de séquence au terminal. Une tabulation devient des espaces (Tab complète, dans
 * Claude Code). Espaces et lignes vides en bout de message : retirés.
 *
 * @param {string} text
 */
export function typedText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
    .trim()
    .split("\n")
    .join("\x1b\r");
}
