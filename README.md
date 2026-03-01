# Atmospheric Equilibrium Visualizer

Interactive toroidal-field visualization of how pressure, humidity, and temperature disturbances propagate and decay in a coupled atmospheric system.

## Run locally

Use any static file server from this directory. Example:

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

## Model notes

- Pressure and temperature are simulated directly as gridded state variables.
- Humidity is simulated as specific humidity (mixing ratio), then converted to relative humidity (%RH) using local pressure and temperature.
- Saturation constraints use Clausius-Clapeyron-style saturation vapor pressure and saturation mixing ratio.
- A phase-change step condenses supersaturated vapor into a condensate reservoir with latent heating.
- Re-evaporation/cooling only occurs when condensate is available, preventing unphysical moisture creation.
- Damping and restoring terms suppress runaway resonance and allow settling.

## What to explore

- Set realistic initial baselines (defaults include 1013.25 hPa standard pressure).
- Toggle `Enforce physical bounds` for realistic ranges or disable it for exploratory mode.
- Toggle `Use saturation-based humidity limits` to constrain RH using saturation vapor pressure and mixing-ratio envelopes from the selected pressure and temperature.
- Review live `Physics Details` (`e_s`, `q_s`, RH envelope, and active RH slider bounds).
- Watch the bottom diagnostics strip for rolling mean `q` (g/kg), mean RH, and supersaturated-cell fraction.
- Toggle `Allow equilibrium baseline drift after injections` to let the system settle to a new post-injection baseline.
- Inject disturbance from any corner or edge and observe wrapped flow across boundaries.
