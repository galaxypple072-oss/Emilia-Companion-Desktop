# Re:Zero Live2D character packs

Each directory contains one original Live2D Cubism 3 classic outfit, normalized to the desktop pet's asset layout:

```text
<character>/classic/
  model.model3.json
  model.moc3
  textures/
  motions/
```

`characters.json` lists the model URL and available motion groups for each character. The model JSON retains the source motion library under the default group and adds the desktop pet groups `Idle`, `Smile`, `Surprise`, `Think`, `Angry`, `Nod`, `Shy`, and `Talk` where source motions exist.

The model can be loaded by `createLive2DPet(canvas, { outfit: { id, model } })`; a caller can play a group with the pet controller's `motion(group)` method. These packs are prepared assets. The current desktop UI still starts with the Emilia wardrobe and does not yet expose a character picker.

Source model IDs:

| Character | Source model |
| --- | --- |
| Rem | `ac_base_rem01` |
| Ram | `ac_base_ram01` |
| Beatrice | `ac_base_beatrice01` |
| Felt | `ac_base_felt01` |
| Crusch | `ac_base_crusch01` |
| Anastasia | `ac_base_anastasia01` |
| Echidna | `ac_base_echidna01` |

Rebuild from an extracted `Live2D Characters` directory with:

```sh
node scripts/prepare-rezero-character-live2d.mjs "/path/to/Live2D Characters"
```
