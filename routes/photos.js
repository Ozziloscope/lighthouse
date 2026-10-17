// Profile photos, so customers can see who is working their ticket.
//   GET    /api/users/:id/photo   anyone who can see that person in the app
//   PUT    /api/me/photo          upload your own photo
//   DELETE /api/me/photo          remove your own photo
//   PUT    /api/users/:id/photo   set someone else's photo     needs "Manage user accounts" (and the usual
//   DELETE /api/users/:id/photo   remove someone else's photo   rule: only people at or below your level)
const { PHOTO_CACHE_SECONDS } = require("../lib/constants");
const { STATUS, fail, idFromPath } = require("../lib/http");
const { preparePhoto } = require("../lib/photos");

module.exports = function registerPhotoRoutes(app) {
  const { route, one, run, db, audit, people, getUserById, requireSignedIn, requirePermission } = app;

  const savePhoto = db.transaction((userId, image) => {
    const now = Date.now();
    run(`INSERT INTO user_photos (user_id, image, updated_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET image = excluded.image, updated_at = excluded.updated_at`, userId, image, now);
    run("UPDATE users SET photo_updated_at = ? WHERE id = ?", now, userId);
    return now;
  });
  const removePhoto = db.transaction((userId) => {
    run("DELETE FROM user_photos WHERE user_id = ?", userId);
    run("UPDATE users SET photo_updated_at = NULL WHERE id = ?", userId);
  });

  route("GET", "/api/users/:id/photo", (request, response) => {
    requireSignedIn(request);
    const personId = idFromPath(request.params.id);
    // "No photo" and "not someone you can see" look the same, so photos can't be used to discover staff.
    const photo = people.canSeePerson(request.user, personId) ? one("SELECT image FROM user_photos WHERE user_id = ?", personId) : null;
    if (!photo) fail(STATUS.notFound, "No photo.");
    response.writeHead(STATUS.ok, {
      "Content-Type": "image/jpeg",
      "Content-Length": photo.image.length,
      // The address includes ?v=<when it was uploaded>, so a new photo gets a new address.
      "Cache-Control": `private, max-age=${PHOTO_CACHE_SECONDS}`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    response.end(photo.image);
  });

  route("PUT", "/api/me/photo", (request) => {
    requireSignedIn(request);
    const photoVersion = savePhoto(request.user.id, preparePhoto(request.body.image));
    audit("photo.update", request, { target: request.user.id });
    return { photoVersion };
  });
  route("DELETE", "/api/me/photo", (request) => {
    requireSignedIn(request);
    removePhoto(request.user.id);
    audit("photo.remove", request, { target: request.user.id });
    return { photoVersion: null };
  });

  function someoneElse(request) {
    requirePermission(request, "users.manage");
    const person = getUserById(idFromPath(request.params.id)) ?? fail(STATUS.notFound, "User not found.");
    if (person.id !== request.user.id) app.assertCanManagePerson(request.user, person);
    return person;
  }
  route("PUT", "/api/users/:id/photo", (request) => {
    const person = someoneElse(request);
    const photoVersion = savePhoto(person.id, preparePhoto(request.body.image));
    audit("photo.update", request, { target: person.id });
    return { photoVersion };
  });
  route("DELETE", "/api/users/:id/photo", (request) => {
    const person = someoneElse(request);
    removePhoto(person.id);
    audit("photo.remove", request, { target: person.id });
    return { photoVersion: null };
  });
};
