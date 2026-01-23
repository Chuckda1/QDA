export type VolumeRegime = "THIN_TAPE" | "LOW_VOL" | "NORMAL" | "VOL_SPIKE" | "CLIMAX_VOL";

export type VolumePolicy = {
  regime: VolumeRegime;
  confirmBarsRequired: number;
  allowOneBarBreakout: boolean;
  requiresRetest: boolean;
  sizeMult: number;
  label: string;
};

export function volumePolicy(relVol?: number): VolumePolicy {
  if (relVol === undefined || !Number.isFinite(relVol)) {
    return {
      regime: "NORMAL",
      confirmBarsRequired: 2,
      allowOneBarBreakout: true,
      requiresRetest: false,
      sizeMult: 1.0,
      label: "NORMAL",
    };
  }

  if (relVol < 0.45) {
    return {
      regime: "THIN_TAPE",
      confirmBarsRequired: 3,
      allowOneBarBreakout: false,
      requiresRetest: true,
      sizeMult: 0.25,
      label: "THIN",
    };
  }

  if (relVol < 0.7) {
    return {
      regime: "LOW_VOL",
      confirmBarsRequired: 2,
      allowOneBarBreakout: false,
      requiresRetest: false,
      sizeMult: 0.5,
      label: "LOW",
    };
  }

  if (relVol >= 2.5) {
    return {
      regime: "CLIMAX_VOL",
      confirmBarsRequired: 1,
      allowOneBarBreakout: true,
      requiresRetest: false,
      sizeMult: 1.25,
      label: "CLIMAX",
    };
  }

  if (relVol >= 1.5) {
    return {
      regime: "VOL_SPIKE",
      confirmBarsRequired: 1,
      allowOneBarBreakout: true,
      requiresRetest: false,
      sizeMult: 1.25,
      label: "SPIKE",
    };
  }

  return {
    regime: "NORMAL",
    confirmBarsRequired: 2,
    allowOneBarBreakout: true,
    requiresRetest: false,
    sizeMult: 1.0,
    label: "NORMAL",
  };
}
