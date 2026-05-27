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
  return group;
}

module.exports = {
  guessDayOfWeekFromName,
  normalizeDeliveryGroup,
};
