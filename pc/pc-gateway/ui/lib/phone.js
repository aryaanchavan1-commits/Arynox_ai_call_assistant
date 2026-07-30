export function comparablePhone(value) {
  if (typeof value !== 'string' || value.length > 64) return '';
  const digits = value.replaceAll(/\D/g, '');
  return digits.length >= 6 && digits.length <= 15 ? digits : '';
}

export function contactForNumber(rows, number) {
  if (!Array.isArray(rows) || rows.length > 700) return null;
  const target = comparablePhone(number);
  if (!target) return null;
  const matches = rows.flatMap((row) => {
    const candidate = comparablePhone(row?.number);
    const name = typeof row?.name === 'string' && row.name.length > 0 && row.name.length <= 256
      ? row.name
      : '';
    if (!candidate || !name) return [];
    const exact = candidate === target;
    const suffix = candidate.length >= 10 && target.length >= 10
      && candidate.slice(-10) === target.slice(-10);
    return exact || suffix ? [{ name, number: row.number, exact }] : [];
  });
  const exactMatches = matches.filter((match) => match.exact);
  if (exactMatches.length > 0) {
    return { name: exactMatches[0].name, number: exactMatches[0].number };
  }
  const names = new Set(matches.map((match) => match.name));
  return matches.length > 0 && names.size === 1
    ? { name: matches[0].name, number: matches[0].number }
    : null;
}

export function incomingCallIdentity(call, contacts = []) {
  const number = typeof call?.displayNumber === 'string' && call.displayNumber.length <= 64
    ? call.displayNumber
    : '';
  const mirrored = contactForNumber(contacts, number);
  const candidates = [
    call?.contactName,
    call?.caller?.name,
    call?.displayName,
    mirrored?.name,
  ];
  const name = candidates.find((value) => (
    typeof value === 'string' && value.length > 0 && value.length <= 256
  )) ?? '';
  return { name, number };
}
