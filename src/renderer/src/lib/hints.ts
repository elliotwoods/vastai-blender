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
    'Estimated spend on this node. The app meters this itself — it adds the rate once a minute while running — so it is not vast.ai’s invoice and reads low if the app was closed.',
  energy: 'GPU energy this node has drawn since it started, from its power readings.',
  actual:
    'Spend so far ÷ how long the node has been up — the realised $/hr. It sits below the quoted rate because provisioning and idle time count too. Estimated, not billed.',
  uptime: 'Time since vast.ai started billing this instance.',
  power: 'Current GPU power draw against the card’s limit, and energy used this session.',

  fleetRate:
    'Combined $/hr of every live node — what the fleet costs while it stays up. Click for spend history.',
  fleetSession:
    'Estimated total spend and GPU energy. The cost log is never cleared, so this covers every run, not just this session. Click for spend history.',
  balance: 'Your vast.ai credit. Click for balance history, or “+” to add funds.',

  co2: 'A rough estimate, not a measurement: metered GPU energy × the grid intensity of the country the node ran in × an overhead factor for the host machine and cooling. Nodes rented before the app recorded their location fall back to a world average, and country averages hide a lot — treat it as an order of magnitude.',

  co2Overhead:
    'Measured GPU watts are scaled by this before becoming a CO₂ figure, to stand in for the host CPU, power-supply losses and datacentre cooling that nvidia-smi never sees. 1.6 is a typical whole-facility ratio; 1 counts the card alone. Energy readouts in Wh are never scaled by it.',

  spendCap:
    'The scheduler won’t start another node if the fleet’s combined quoted rate would go above this. Leave blank to disable the cap.',
  maxDph:
    'Offer filter — only machines at or below this on-demand price are considered when renting.'
} as const
