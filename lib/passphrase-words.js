// Short, common, easy-to-spell words for emailed reset passphrases (see generatePassphrase in passwords.js).
// Four words picked at random from this list, plus a number, gives over 37 bits of randomness; the passphrase
// only works for 30 minutes and sign-in attempts are throttled, so that is far more than enough.
module.exports = [
  "acorn", "actor", "adobe", "agent", "alarm", "album", "alley", "amber", "anchor", "angle", "apple", "apron",
  "arena", "arrow", "aspen", "atlas", "attic", "autumn", "avenue", "badge", "bagel", "baker", "bamboo", "banjo",
  "barn", "basil", "basin", "beach", "beacon", "beaver", "bench", "berry", "bison", "blade", "blanket", "bloom",
  "board", "boat", "bonus", "border", "bottle", "branch", "brass", "bread", "breeze", "brick", "bridge", "brook",
  "broom", "bucket", "buffalo", "bundle", "cabin", "cactus", "camel", "candle", "canoe", "canyon", "captain",
  "carbon", "carpet", "castle", "cedar", "cellar", "cement", "chalk", "chapel", "cherry", "chess", "chimney",
  "cider", "circle", "cliff", "clock", "cloud", "clover", "cobalt", "coffee", "comet", "compass", "copper", "coral",
  "cotton", "cougar", "crane", "crater", "crayon", "creek", "cricket", "crystal", "cube", "curtain", "cypress",
  "dagger", "daisy", "dancer", "delta", "desert", "diamond", "dinner", "dolphin", "donkey", "dragon", "drum",
  "eagle", "easel", "echo", "elbow", "ember", "emerald", "engine", "falcon", "feather", "fence", "fern", "ferry",
  "fiddle", "field", "finch", "flame", "flute", "forest", "fossil", "fountain", "fox", "galaxy", "garden", "garlic",
  "gazelle", "geyser", "ginger", "glacier", "globe", "goose", "granite", "grape", "gravel", "guitar", "hammer",
  "harbor", "hazel", "heron", "hickory", "hiker", "hollow", "honey", "hornet", "island", "ivory", "jacket", "jaguar",
  "jasmine", "jelly", "jungle", "kayak", "kettle", "kitten", "koala", "ladder", "lagoon", "lantern", "laptop",
  "lemon", "lilac", "linen", "lizard", "lobster", "locket", "lotus", "lumber", "magnet", "mango", "maple", "marble",
  "meadow", "melon", "meteor", "mint", "mirror", "mitten", "moose", "mosaic", "mountain", "muffin", "nectar",
  "needle", "nickel", "noodle", "oasis", "ocean", "olive", "onion", "orbit", "orchid", "otter", "oven", "owl",
  "paddle", "palm", "panda", "paper", "parrot", "peach", "pebble", "pelican", "pepper", "piano", "pickle", "pigeon",
  "pillow", "pine", "planet", "plum", "pocket", "pony", "poppy", "pretzel", "prism", "pumpkin", "puzzle", "quartz",
  "quill", "rabbit", "radar", "radish", "raven", "reef", "ribbon", "river", "robin", "rocket", "saddle", "salmon",
  "sandal", "satin", "scarf", "shadow", "shell", "signal", "silver", "sketch", "sled", "sparrow", "spider", "spruce",
  "squash", "staple", "statue", "stone", "storm", "summit", "sunset", "swan", "tablet", "teapot", "temple",
  "thistle", "thunder", "tiger", "timber", "toast", "tomato", "topaz", "tractor", "trail", "tulip", "tunnel",
  "turtle", "valley", "velvet", "violet", "volcano", "wagon", "walnut", "walrus", "willow", "window", "winter",
  "wizard", "yarrow", "zebra", "zephyr"
];
