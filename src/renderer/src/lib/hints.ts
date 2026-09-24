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

  fleetRate:
    'Combined $/hr of every live node — what the fleet costs while it stays up. Click for spend history.',
  fleetSession:
    'Estimated total spend across every run (the cost log is never cleared), and GPU energy since the app was opened. Click for spend history.',
  balance: 'Your vast.ai credit. Click for balance history, or “+” to add funds.',

  co2: 'A rough estimate, not a measurement: metered GPU energy × the grid intensity of the country the node ran in × an overhead factor for the host machine and cooling. Nodes rented before the app recorded their location fall back to a world average, and country averages hide a lot — treat it as an order of magnitude.',

  co2Overhead:
    'Measured GPU watts are scaled by this before becoming a CO₂ figure, to stand in for the host CPU, power-supply losses and datacentre cooling that nvidia-smi never sees. 1.6 is a typical whole-facility ratio; 1 counts the card alone. Energy readouts in Wh are never scaled by it.',

  spendCap:
    'Automatic scale-up stops renting once the fleet’s combined quoted rate reaches this. The next machine’s price is not counted, so the last rental can take the fleet over the cap, and “+ request node” ignores it. Leave blank to disable the cap.',
  maxDph:
    'Offer filter — only machines at or below this on-demand price are considered when renting.'
} as const
