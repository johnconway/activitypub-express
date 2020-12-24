'use strict'
const mongo = require('mongodb')
const IApexStore = require('./interface')

class ApexStore extends IApexStore {
  constructor () {
    super()
    this.projection = { _id: 0, _meta: 0 }
    this.metaProj = { _id: 0 }
  }

  async deliveryEnqueue (actorId, body, addresses, signingKey) {
    if (!addresses || !addresses.length) return
    if (!Array.isArray(addresses)) { addresses = [addresses] }
    const docs = addresses.map(address => ({
      address,
      actorId,
      signingKey,
      body,
      attempt: 0
    }))
    await this.db.collection('deliveryQueue')
      .insertMany(docs, { ordered: false, forceServerObjectId: true })
    // TODO maybe catch errored docs and retry?
    return true
  }

  async deliveryDequeue () {
    const result = await this.db.collection('deliveryQueue')
      .findOneAndDelete({}, { sort: { _id: 1 }, projection: { _id: 0 } })
    return result.value
  }

  async deliveryRequeue (delivery) {
    delivery.attempt++
    const result = await this.db.collection('deliveryQueue')
      .insertOne(delivery, { forceServerObjectId: true })
    return result.insertedCount
  }

  async setup (initialUser) {
    const db = this.db
    // inbox
    await db.collection('streams').createIndex({
      id: 1
    }, {
      name: 'streams-primary',
      unique: true
    })
    await db.collection('streams').createIndex({
      '_meta.collection': 1,
      _id: -1
    }, {
      name: 'collections'
    })
    // object lookup
    await db.collection('objects').createIndex({ id: 1 }, { unique: true, name: 'objects-primary' })
    if (initialUser) {
      return db.collection('objects').findOneAndReplace(
        { id: initialUser.id },
        initialUser,
        {
          upsert: true,
          returnOriginal: false
        }
      )
    }
  }

  getObject (id, includeMeta) {
    return this.db
      .collection('objects')
      .find({ id: id })
      .limit(1)
      // strict comparison as we don't want to return private keys on accident
      .project(includeMeta === true ? this.metaProj : this.projection)
      .next()
  }

  async saveObject (object) {
    const db = this.db
    const exists = await db.collection('objects')
      .find({ id: object.id })
      .project({ _id: 1 })
      .limit(1)
      .hasNext()
    if (exists) {
      return false
    }
    return db.collection('objects')
      .insertOne(object, { forceServerObjectId: true })
  }

  async updateObject (obj, actorId, fullReplace) {
    const updated = await this.updateObjectSource(obj, actorId, fullReplace)
    if (updated) {
      // propogate update to all copies in streams
      await this.updateObjectCopies(updated)
    }
    return updated
  }

  getActivity (id, includeMeta) {
    return this.db.collection('streams')
      .find({ id: id })
      .limit(1)
      .project(includeMeta ? this.metaProj : this.projection)
      .next()
  }

  getStream (collectionId) {
    const query = this.db
      .collection('streams')
      .find({ '_meta.collection': collectionId })
      .sort({ _id: -1 })
      .project({ _id: 0, _meta: 0, 'object._id': 0, 'object._meta': 0 })
    return query.toArray()
  }

  async saveActivity (activity) {
    let inserted
    try {
      const insertResult = await this.db.collection('streams')
        .insertOne(activity, { forceServerObjectId: true })
      inserted = insertResult.insertedCount
    } catch (err) {
      // if duplicate key error, ignore and return undefined
      if (err.name !== 'MongoError' || err.code !== 11000) throw (err)
    }
    return inserted
  }

  removeActivity (activity, actorId) {
    return this.db.collection('streams')
      .deleteMany({ id: activity.id, actor: actorId })
  }

  async updateActivity (activity, fullReplace) {
    if (!fullReplace) {
      throw new Error('not implemented')
    }
    const result = await this.db.collection('streams')
      .replaceOne({ id: activity.id }, activity)
    return result.modifiedCount
  }

  async updateActivityMeta (activity, key, value, remove) {
    const op = {}
    if (remove) {
      op.$pull = { [`_meta.${key}`]: value }
    } else {
      op.$addToSet = { [`_meta.${key}`]: value }
    }
    const q = { id: activity.id }
    const result = await this.db.collection('streams')
      .findOneAndUpdate(q, op, { projection: this.metaProj, returnOriginal: false })
    if (!result.ok || !result.value) {
      throw new Error('Error updating activity meta: not found')
    }
    return result.value
  }

  generateId () {
    return new mongo.ObjectId().toHexString()
  }

  // class methods
  updateObjectSource (object, actorId, fullReplace) {
    // limit udpates to owners of objects
    const q = object.id === actorId
      ? { id: object.id }
      : { id: object.id, attributedTo: actorId }
    if (fullReplace) {
      return this.db.collection('objects')
        .replaceOne(q, object)
        .then(result => {
          if (result.modifiedCount > 0) {
            return object
          }
        })
    }
    let doSet = false
    let doUnset = false
    const set = {}
    const unset = {}
    const op = {}
    for (const [key, value] of Object.entries(object)) {
      if (key === 'id') continue
      if (value === null) {
        doUnset = true
        unset[key] = ''
      } else {
        doSet = true
        set[key] = value
      }
    }
    if (doSet) {
      op.$set = set
    }
    if (doUnset) {
      op.$unset = unset
    }

    return this.db.collection('objects')
      .findOneAndUpdate(q, op, { returnOriginal: false, projection: this.projection })
      .then(result => result.value)
  }

  // for denormalized storage model, must update all activities with copy of updated object
  /* TODO: if this is a profile update that includes a private key change, need to update
     copies in delivery queue */
  updateObjectCopies (object) {
    return this.db.collection('streams')
      .updateMany({ 'object.0.id': object.id }, { $set: { object: [object] } })
  }
}

module.exports = ApexStore
