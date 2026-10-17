// Where a person's alerts actually go. Only confirmed (verified) addresses and numbers are ever used.
// The email an admin typed on the account counts as confirmed, because an admin set it.

// The address email alerts go to: a confirmed alert address if they set one, otherwise the account email.
const verifiedEmailOf = (person) => (person.alert_email && person.alert_email_verified ? person.alert_email : null) || person.email || null;

// The number text alerts go to, once confirmed with a code.
const verifiedPhoneOf = (person) => (person.phone && person.phone_verified ? person.phone : null);

module.exports = { verifiedEmailOf, verifiedPhoneOf };
