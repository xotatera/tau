/** This fork is distributed from source; never adopt the upstream Pi release channel. */
export const TAU_SELF_UPDATE_UNAVAILABLE =
	"Automatic Tau updates are unavailable in this source-only fork. Update your Tau source checkout from https://github.com/xotatera/tau.";

export function isTauPackage(packageName: string): boolean {
	return packageName === "@xotatera/tau-coding-agent";
}
