/**
 * What to do about a failed check. Fixed text, keyed by check: the
 * verifier doesn't compose advice, and nothing an agent says can change
 * it.
 */
export const FIXES: Record<string, string> = {
  "IDN-01": "Give the agent an identity: `npx @adasouls/alma-cli connect`, or register it with your ALMA provider.",
  "IDN-02": "Link the identity to the person or organization it acts for; delegations are issued by that principal.",
  "IDN-03": "Bind the wallet to the identity as a wallet controller (`alma connect --wallet 0x…`), proven with a signature from that wallet. Until it is bound the verdict stays ADVISORY, however well that wallet is protected.",
  "AUT-01": "Have the principal delegate every capability the agent declares, or remove the capabilities it doesn't need.",
  "AUT-02": "Reissue the delegation with an expiry (90 days is a sensible default) and renew it deliberately.",
  "AUT-03": "Reissue the chained delegation so that it grants no more than its issuer holds.",
  "POL-01": "Add a `maxTransaction` entry for every asset in `allowedAssets` in alma.yaml.",
  "POL-02": "Lower `humanApprovalThreshold` below `maxTransaction`, or remove it if no approval is intended.",
  "POL-03": "Raise `dailySpend` to at least `maxTransaction`, or lower `maxTransaction` to what is really meant.",
  "POL-04": "Add a `counterpartyPolicy` to alma.yaml: an allowlist, or a minimum of completed transactions.",
  "POL-05": "Tighten the agent's limits to what its organization and its delegation allow. An agent's own rules can't raise them.",
  "CUS-01": "Stop giving the agent the wallet's key. Route: let a custody service sign after checking the limits. Lock: move the funds to a Safe and make the agent a delegate of its Allowance Module.",
  "CUS-02": "Remove the agent's signer from the Safe's owners, or raise the threshold above one. The agent should be a delegate with an allowance, never an owner.",
  "CUS-03": "Enable the Allowance Module on the Safe, add the agent's signer as a delegate, and set each asset's allowance to the declared daily limit.",
  "CUS-04": "Lower the on-chain allowance to the declared daily limit (`setAllowance` from the Safe), or raise the declared limit if the chain is right.",
  "CUS-05": "Move those funds into the Safe. Anything at an address the agent signs for is outside every limit.",
  "HIS-01": "A receipt that doesn't verify was edited or signed with another key. Find out which before relying on this history.",
  "HIS-02": "The log was changed after the fact. Restore it from a copy that matches its last published head.",
  "HIS-03": "Nothing to fix now: the limits were looser, or absent, when those payments were made.",
};
