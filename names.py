"""Generated names of the agents without a name: an adjective and an animal ("Agile Otter"), unique and stable.

Names generated before English became the default were French, animal first ("Loutre agile"); they stay as they
were saved. `FRENCH_ANIMALS` maps their animal to its English name, which is also the id of an animal avatar
(older avatars saved the French name).
"""

import random

ANIMALS = (
    "Antelope", "Badger", "Bear", "Beaver", "Bison", "Blackbird", "Chameleon", "Chamois", "Condor", "Deer",
    "Dolphin", "Duck", "Eagle", "Ermine", "Falcon", "Fennec", "Ferret", "Flamingo", "Fox", "Frog", "Gazelle",
    "Gecko", "Giraffe", "Hare", "Hedgehog", "Heron", "Hummingbird", "Iguana", "Jaguar", "Koala", "Llama", "Lynx",
    "Marmot", "Meerkat", "Mongoose", "Moose", "Ocelot", "Octopus", "Okapi", "Orca", "Otter", "Owl", "Owlet",
    "Panda", "Parrot", "Pelican", "Penguin", "Puma", "Rabbit", "Raven", "Salamander", "Seahorse", "Seal",
    "Sparrow", "Squirrel", "Stag", "Swan", "Tapir", "Tiger", "Toucan", "Turtle", "Vulture", "Walrus", "Whale",
    "Wolf", "Wombat", "Yak", "Zebra",
)
ADJECTIVES = (
    "Agile", "Alert", "Brave", "Calm", "Clever", "Famous", "Fearless", "Free", "Friendly", "Gentle", "Graceful",
    "Keen", "Loyal", "Lunar", "Modest", "Nimble", "Noble", "Peaceful", "Placid", "Polar", "Quiet", "Rare",
    "Rustic", "Serene", "Shy", "Sincere", "Solar", "Solid", "Speedy", "Splendid", "Steady", "Sturdy", "Swift",
    "Tenacious", "Wild", "Wise",
)
FRENCH_ANIMALS = {
    "Aigle": "Eagle", "Antilope": "Antelope", "Baleine": "Whale", "Bison": "Bison", "Blaireau": "Badger",
    "Caméléon": "Chameleon", "Canard": "Duck", "Castor": "Beaver", "Cerf": "Stag", "Chamois": "Chamois",
    "Chouette": "Owlet", "Colibri": "Hummingbird", "Condor": "Condor", "Corbeau": "Raven", "Cygne": "Swan",
    "Daim": "Deer", "Dauphin": "Dolphin", "Écureuil": "Squirrel", "Élan": "Moose", "Faucon": "Falcon",
    "Fennec": "Fennec", "Flamant": "Flamingo", "Furet": "Ferret", "Gazelle": "Gazelle", "Gecko": "Gecko",
    "Girafe": "Giraffe", "Grenouille": "Frog", "Hérisson": "Hedgehog", "Hermine": "Ermine", "Héron": "Heron",
    "Hibou": "Owl", "Hippocampe": "Seahorse", "Iguane": "Iguana", "Jaguar": "Jaguar", "Koala": "Koala",
    "Lama": "Llama", "Lapin": "Rabbit", "Lièvre": "Hare", "Loup": "Wolf", "Loutre": "Otter", "Lynx": "Lynx",
    "Manchot": "Penguin", "Mangouste": "Mongoose", "Marmotte": "Marmot", "Merle": "Blackbird", "Morse": "Walrus",
    "Moineau": "Sparrow", "Ocelot": "Ocelot", "Okapi": "Okapi", "Orque": "Orca", "Ours": "Bear", "Panda": "Panda",
    "Pélican": "Pelican", "Perroquet": "Parrot", "Phoque": "Seal", "Poulpe": "Octopus", "Puma": "Puma",
    "Renard": "Fox", "Salamandre": "Salamander", "Suricate": "Meerkat", "Tapir": "Tapir", "Tigre": "Tiger",
    "Tortue": "Turtle", "Toucan": "Toucan", "Vautour": "Vulture", "Wombat": "Wombat", "Yak": "Yak", "Zèbre": "Zebra",
}


def generate_name(taken=(), rng=random):
    """A free name (not in `taken`, ignoring case); numbered if they are all taken."""
    used = {name.casefold() for name in taken}
    free = [f"{adjective} {animal}" for adjective in ADJECTIVES for animal in ANIMALS
            if f"{adjective} {animal}".casefold() not in used]
    if free:
        return rng.choice(free)
    base = f"{rng.choice(ADJECTIVES)} {rng.choice(ANIMALS)}"
    number = 2
    while f"{base} {number}".casefold() in used:
        number += 1
    return f"{base} {number}"
