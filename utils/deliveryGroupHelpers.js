const UKRAINIAN_DAY_NAMES = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
const DAY_NAME_TO_NUMBER = Object.fromEntries(UKRAINIAN_DAY_NAMES.map((name, idx) => [name, idx]));

function guessDayOfWeekFromName(name) {
  if (!name) return null;
  const normalizedName = String(name).trim().toLowerCase();
  for (const [dayName, dayIndex] of Object.entries(DAY_NAME_TO_NUMBER)) {
    if (normalizedName.includes(dayName.toLowerCase())) {
      return dayIndex;
    }
  }
  return null;
}

function normalizeDeliveryGroup(group) {
  if (!group) return group;
  const rawDayOfWeek = group.dayOfWeek;
  const numericDayOfWeek = Number.isFinite(Number(rawDayOfWeek)) ? Number(rawDayOfWeek) : null;
  const validDayOfWeek = numericDayOfWeek !== null && numericDayOfWeek >= 0 && numericDayOfWeek <= 6 ? numericDayOfWeek : null;
  const guessedDayOfWeek = guessDayOfWeekFromName(group.name);

  if (guessedDayOfWeek !== null && guessedDayOfWeek !== validDayOfWeek) {
    return { ...group, dayOfWeek: guessedDayOfWeek };
  }

  return group;
}

module.exports = {
  guessDayOfWeekFromName,
  normalizeDeliveryGroup,
};
