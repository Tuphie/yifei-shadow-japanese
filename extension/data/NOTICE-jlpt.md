# data/jlpt.json — attribution and license

`jlpt.json` is a compact word → reading → JLPT level table (plus kanji → level) derived from
**[OpenJLPT](https://pypi.org/project/openjlpt/) 0.1.0**, which is licensed under
**[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)**.
This file is therefore also distributed under **CC BY-SA 4.0** (the rest of Kage is MIT).

Changes made: kept only the word, reading and level columns (no glosses or example sentences),
split alternative spellings ("作る/造る"), removed annotations in parentheses, converted readings
to hiragana, and packed everything into one JSON file.

Upstream sources, as credited by OpenJLPT:

| Source | Used for | License |
|---|---|---|
| Jonathan Waller's JLPT Resources (tanos.co.uk) | N5–N1 level assignments for vocabulary and kanji | CC BY |
| JMdict / EDICT and KANJIDIC2 — Electronic Dictionary Research and Development Group (EDRDG) | readings | CC BY-SA 4.0 |

The JLPT organisation has not published official vocabulary lists since 2010. These levels are
community approximations and are shown in Kage as reference values only.
