/**
 * Explanatory tooltip copy, in one place so the same number is described the
 * same way wherever it appears (fleet column header, node detail, toolbar).
 *
 * Money note: every `$` figure in this app is an *estimate*. `dph_total` is the
 * on-demand price captured from the offer at rent time and never refreshed, and
 * spend is metered locally — nodeManager adds `dph_total / 60` once a minute
 * while the app is running. Nothing is read back from vast.ai's billing, so the
 * wording below deliberately avoids implying these are invoiced amounts.
 */

export const HINTS = {
  rate: 'The on-demand price vast.ai quoted for this machine, fixed when it was rented.',
  spent:
    'Estimated spend on this node. The app meters this itself — it adds a minute of the rate once a minute while running — so it is not vast.ai’s invoice and reads low if the app was closed or the computer slept.',
  energy:
    'GPU energy this node has drawn since the app was opened, from its power readings. It is not kept across a restart.',
  actual:
    'Metered spend ÷ how long the node has been up. The app meters at the quoted rate, provisioning and idle time included, so this settles at about that rate. It reads high at first, because the meter charges whole minutes: up to about a third over the rate when it first shows, at 3 minutes. It reads lower only for time the app did not meter, such as while it was closed or asleep. Estimated, not billed.',
  uptime: 'Time since vast.ai started billing this instance.',
  power: 'Current GPU power draw against the card’s limit, and energy used this session.',
  gpuTrend:
    'GPU utilisation over the last 30 minutes: the line is the mean across the node’s GPUs, the band runs from its least to its most busy card. A wide band under a low line is one card working while the others idle. Hover or focus it to read a moment.',

  fleetRate:
    'Combined $/hr of every node that may be billing: booting, working, or failed with its destroy not yet confirmed by Vast — and the GPU power the fleet is drawing right now (latest nvidia-smi sample per node, refreshed every 15 s). Click for spend history.',
  fleetSession:
    'Estimated total spend across every run (the cost log is never cleared), and GPU energy since the app was opened. Click for spend history.',
  balance: 'Your vast.ai credit. Click for balance history, or “+” to add funds.',

  co2: 'A rough estimate, not a measurement: metered GPU energy × the grid intensity of the country the node ran in × an overhead factor for the host machine and cooling. Nodes rented before the app recorded their location fall back to a world average, and country averages hide a lot — treat it as an order of magnitude.',

  co2Overhead:
    'Measured GPU watts are scaled by this before becoming a CO₂ figure, to stand in for the host CPU, power-supply losses and datacentre cooling that nvidia-smi never sees. 1.6 is a typical whole-facility ratio; 1 counts the card alone. Energy readouts in Wh are never scaled by it.',

  spendCap:
    'The most the fleet may bill per hour, counting every node that may still be billing. A machine is rented only if its own price still fits under the cap, and “+ request node” stops at it too. Tick “no spend cap” to rent without one.',
  vastApiKey:
    'Stored encrypted by your OS (Keychain / DPAPI) and used only by this app to talk to vast.ai — it is never copied to the rented machines. Vast has no sign-in for apps, so a key is the only way; a restricted one limits what it can do if it leaks.',
  maxDph:
    'Offer filter — only machines at or below this on-demand price are considered when renting.'
} as const
