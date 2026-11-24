---
'@dashlint/cli': patch
---

A spread of a class instance no longer lists its `#private` fields as event properties: JavaScript never copies them. A string key that looks like a private or symbol name, such as `'__#copy'`, is kept.
