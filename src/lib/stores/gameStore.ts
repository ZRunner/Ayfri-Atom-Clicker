import {derived, get, writable} from 'svelte/store';
import {type BuildingType} from '$data/buildings';
import {POWER_UP_DEFAULT_INTERVAL} from '$data/powerUp';
import {UPGRADES} from '$data/upgrades';
import {SKILL_UPGRADES} from '$data/skillTree';
import type {Building, Effect, PowerUp, Range, Upgrade, SkillUpgrade} from '../types';

// Individual stores
export const achievements = writable<string[]>([]);
export const activePowerUps = writable<PowerUp[]>([]);
export const atoms = writable<number>(0);
export const buildings = writable<Partial<Record<BuildingType, Building>>>({});
export const lastSave = writable<number>(Date.now());
export const skillUpgrades = writable<string[]>([]);
export const totalClicks = writable<number>(0);
export const totalXP = writable<number>(0);
export const upgrades = writable<string[]>([]);

// Using a geometric progression formula
export function getXPForLevel(level: number) {
	const base = 100;
	const taux = 0.42; // 42%
	return Math.floor(base * Math.pow(1 + taux, level - 1));
}

// Derived stores for level system
export const playerLevel = derived(totalXP, $totalXP => {
    let level = 0;
	let remainingXP = $totalXP;
	while (remainingXP >= getXPForLevel(level + 1)) {
		remainingXP -= getXPForLevel(level + 1);
		level++;
	}
	return level;
});

export const currentLevelXP = derived([totalXP, playerLevel], ([$totalXP, $playerLevel]) => {
    if ($playerLevel === 0) return $totalXP;
    const previousLevelXP = Array.from({ length: $playerLevel }, (_, i) => getXPForLevel(i + 1)).reduce((acc, val) => acc + val, 0);
    return Math.max(0, $totalXP - previousLevelXP);
});

export const nextLevelXP = derived(playerLevel, $playerLevel => getXPForLevel($playerLevel + 1));

export const xpProgress = derived(
    [currentLevelXP, nextLevelXP],
    ([$currentLevelXP, $nextLevelXP]) => ($currentLevelXP / $nextLevelXP) * 100
);

interface SearchEffectsOptions {
	target?: Effect['target'];
	type?: Effect['type'];
	value_type?: Effect['value_type'];
}

function getUpgradesWithEffects(upgrades: (Upgrade | SkillUpgrade)[], options: SearchEffectsOptions) {
	return upgrades.filter((upgrade): upgrade is (Upgrade | SkillUpgrade) => {
		// First check if it's a regular upgrade
		if ('effects' in upgrade && Array.isArray(upgrade.effects)) {
			const effects = upgrade.effects;
			let isType = true;
			let isValueType = true;
			let isTarget = true;

			if (options.type) {
				isType = effects.some(effect => effect.type === options.type);
			}
			if (options.value_type) {
				isValueType = effects.some(effect => effect.value_type === options.value_type);
			}
			if (options.target) {
				isTarget = effects.some(effect => effect.target === options.target);
			}
			return isType && isValueType && isTarget;
		}

		return false;
	});
}

function calculateEffects(upgrades: (Upgrade | SkillUpgrade)[], defaultValue: number = 0): number {
	let multiplier = defaultValue;

	upgrades.forEach((upgrade) => {
		if ('effects' in upgrade && Array.isArray(upgrade.effects)) {
			const addEffects = upgrade.effects.filter(effect => effect.value_type === 'add');
			multiplier += addEffects.reduce((acc, effect) => acc + effect.value, 0);

			const multiplyEffects = upgrade.effects.filter(effect => effect.value_type === 'multiply');
			multiplier *= multiplyEffects.reduce((acc, effect) => acc * effect.value, 1);

			// Add by % of atoms per second
			const addAPSEffects = upgrade.effects.filter(effect => effect.value_type === 'add_aps');
			multiplier += addAPSEffects.reduce((acc, effect) => acc + effect.value, 0) * get(atomsPerSecond);

			// Add by % of achievements unlocked
			const addAchEffects = upgrade.effects.filter(effect => effect.value_type === 'add_ach');
			multiplier += addAchEffects.reduce((acc, effect) => acc + effect.value, 0) * get(achievements).length;

			// Add by xp level
			const addLevelsEffects = upgrade.effects.filter(effect => effect.value_type === 'add_levels');
			multiplier += addLevelsEffects.reduce((acc, effect) => acc + effect.value, 0) * get(playerLevel);
		} else {
			const skillUpgrade = upgrade as SkillUpgrade;
			if ('buildingLevel' in skillUpgrade && 'description' in skillUpgrade) {
				const description = skillUpgrade.description;
				const percentageMatch = description.match(/(\d+)%/);
				if (percentageMatch) {
					const percentage = parseInt(percentageMatch[1]);
					multiplier *= 1 + percentage / 100;
				}
			}
		}
	});

	return multiplier;
}

// Derived stores
export const currentUpgradesBought = derived(
	[upgrades, skillUpgrades],
	([$upgrades, $skillUpgrades]) => {
		const allUpgradeIds = [...$upgrades, ...$skillUpgrades];
		return allUpgradeIds
			.filter(id => UPGRADES[id] || SKILL_UPGRADES[id])
			.map(id => UPGRADES[id] || SKILL_UPGRADES[id]);
	}
);

export const bonusMultiplier = derived(activePowerUps, $activePowerUps => {
	return $activePowerUps.reduce((acc, powerUp) => acc * powerUp.multiplier, 1);
});

export const globalMultiplier = derived(currentUpgradesBought, $currentUpgradesBought => {
	const globalUpgrades = getUpgradesWithEffects($currentUpgradesBought, { type: 'global'});
	return calculateEffects(globalUpgrades, 1);
});

export const hasBonus = derived(activePowerUps, $activePowerUps => $activePowerUps.length > 0);

export const buildingProductions = derived(
	[
		buildings,
		currentUpgradesBought,
		globalMultiplier,
		bonusMultiplier
	],
	([$buildings, $currentUpgradesBought, $globalMultiplier, $bonusMultiplier]) => {
		return Object.entries($buildings).reduce((acc, [type, building]) => {
			let production = 0;
			if (building) {
				const upgrades = getUpgradesWithEffects($currentUpgradesBought, { target: type, type: 'building' });
				const multiplier = calculateEffects(upgrades, building.rate);
				const levelMultiplier = building.level > 0 ? (building.count / 2) ** (building.level + 1) / 5 : 1;
				production = building.count * multiplier * levelMultiplier * $globalMultiplier * $bonusMultiplier;
			}
			return {
				...acc,
				[type]: production,
			};
		}, {} as Record<BuildingType, number>);
	}
);

export const atomsPerSecond = derived(
	[
		buildingProductions,
	],
	([$buildingProductions]) => {
		return Object.entries($buildingProductions).reduce((total, [_, building]) => total + building, 0);
	}
);

export const skillPointsTotal = derived([buildings], ([$buildings]) => Object.values($buildings).reduce((sum, building) => sum + building.level, 0));
export const skillPointsAvailable = derived([skillPointsTotal, skillUpgrades], ([$skillPointsTotal, $skillUpgrades]) => $skillPointsTotal - $skillUpgrades.length);

export const clickPower = derived(
	[
		currentUpgradesBought,
		atomsPerSecond,
		globalMultiplier,
		bonusMultiplier
	],
	([$currentUpgradesBought, $atomsPerSecond, $globalMultiplier, $bonusMultiplier]) => {
		const clickUpgrades = getUpgradesWithEffects($currentUpgradesBought, { type: 'click' });
		const apsClickUpgrades = getUpgradesWithEffects(clickUpgrades, { value_type: 'add_aps'});
		const nonAPSClickUpgrades = clickUpgrades.filter(upgrade => !apsClickUpgrades.includes(upgrade));

		const apsClickResult = calculateEffects(apsClickUpgrades, 1);
		return calculateEffects(nonAPSClickUpgrades, 1) * $globalMultiplier * $bonusMultiplier + apsClickResult;
	}
);

export const powerUpInterval = derived(currentUpgradesBought, $currentUpgradeBought => {
	const powerUpIntervalUpgrades = getUpgradesWithEffects($currentUpgradeBought, { type: 'power_up_interval' });
	return POWER_UP_DEFAULT_INTERVAL.map(interval => calculateEffects(powerUpIntervalUpgrades, interval)) as Range;
});
