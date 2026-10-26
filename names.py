"""Noms générés des agents sans nom : un animal et un adjectif (« Loutre agile »), uniques et stables.

Les adjectifs sont invariables en genre, pour s'accorder avec tous les animaux.
"""

import random

ANIMALS = (
    "Aigle", "Antilope", "Baleine", "Bison", "Blaireau", "Caméléon", "Canard", "Castor", "Cerf", "Chamois",
    "Chouette", "Colibri", "Condor", "Corbeau", "Cygne", "Daim", "Dauphin", "Écureuil", "Élan", "Faucon",
    "Fennec", "Flamant", "Furet", "Gazelle", "Gecko", "Girafe", "Grenouille", "Hérisson", "Hermine", "Héron",
    "Hibou", "Hippocampe", "Iguane", "Jaguar", "Koala", "Lama", "Lapin", "Lièvre", "Loup", "Loutre", "Lynx",
    "Manchot", "Mangouste", "Marmotte", "Merle", "Morse", "Moineau", "Ocelot", "Okapi", "Orque", "Ours",
    "Panda", "Pélican", "Perroquet", "Phoque", "Poulpe", "Puma", "Renard", "Salamandre", "Suricate", "Tapir",
    "Tigre", "Tortue", "Toucan", "Vautour", "Wombat", "Yak", "Zèbre",
)
ADJECTIVES = (
    "agile", "alerte", "brave", "calme", "célèbre", "docile", "fidèle", "habile", "intrépide", "libre",
    "lucide", "lunaire", "magnifique", "mobile", "noble", "pacifique", "paisible", "placide", "polaire",
    "rapide", "rare", "robuste", "rustique", "sage", "sauvage", "sincère", "sobre", "solaire", "solide",
    "souple", "stable", "sympathique", "tenace", "timide", "tranquille", "véloce",
)


def generate_name(taken=(), rng=random):
    """Un nom libre (absent de `taken`, sans tenir compte de la casse) ; numéroté si tous sont pris."""
    used = {name.casefold() for name in taken}
    free = [f"{animal} {adjective}" for animal in ANIMALS for adjective in ADJECTIVES
            if f"{animal} {adjective}".casefold() not in used]
    if free:
        return rng.choice(free)
    base = f"{rng.choice(ANIMALS)} {rng.choice(ADJECTIVES)}"
    number = 2
    while f"{base} {number}".casefold() in used:
        number += 1
    return f"{base} {number}"
