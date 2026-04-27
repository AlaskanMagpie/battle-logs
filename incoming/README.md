Drop Meshy GLB exports here when you pull them out of chat or Downloads, then run:

```powershell
npm run assets:import-meshy
```

The importer recursively copies `*.glb` files into `public/assets/units/` and regenerates `manifest.json`. Filenames and parent folder names are used to infer roles like `run`, `idle`, `attack`, and `death`, plus unit size words like `swarm`, `line`, `heavy`, `titan`, or `hero`.

If Meshy gives you generic files like `Meshy_AI_model.glb`, put them in descriptive folders first, for example:

```text
incoming/frost_heavy_run/Meshy_AI_model.glb
incoming/frost_heavy_attack/Meshy_AI_model.glb
incoming/frost_heavy_idle/Meshy_AI_model.glb
incoming/frost_heavy_death/Meshy_AI_model.glb
```

Everything in this folder except this file is gitignored so large drops do not get committed by mistake.
