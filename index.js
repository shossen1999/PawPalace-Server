
const express = require("express");
const cors = require("cors");
const jwt = require('jsonwebtoken');
require("dotenv").config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const schedule = require("node-schedule"); // kept in case used elsewhere
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const port = process.env.PORT || 5000;
const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://paw-palace-4dac4.web.app"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.json());

// MongoDB connection URI (keep your existing)
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wzcn8fz.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true } });

// Nodemailer transporter (reuse this)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

// ----------------------
// Vaccine intervals configuration (in days)
// Expanded to cover vaccines used in frontend AddPet.jsx
// ----------------------
const vaccineIntervals = {
  // DOG
  "Rabies": 365,
  "Canine Distemper Virus": 365,
  "Canine Adenovirus (Hepatitis)": 365,
  "Canine Parvovirus": 365,
  "Canine Parainfluenza Virus": 365,
  "Bordetella (Kennel Cough)": 180,
  "Leptospirosis": 365,
  "Canine Influenza": 365,
  "Lyme Disease": 365,

  // CAT
  "Feline Viral Rhinotracheitis (FHV-1)": 365,
  "Feline Calicivirus (FCV)": 365,
  "Feline Panleukopenia (FPV)": 365,
  "Feline Leukemia Virus (FeLV)": 365,
  "Feline Immunodeficiency Virus (FIV)": 365,
  "Chlamydophila felis": 365,

  // RABBIT
  "Myxomatosis": 365,
  "Rabbit Haemorrhagic Disease (RHDV1 & RHDV2)": 365,

  // BIRD (examples)
  "Avian Polyomavirus (rare cases)": 365,
  "Pigeon Pox (specific species)": 365,

  // FISH (rare / placeholders)
  // if you don't use these, it's OK — having them avoids undefined lookup
  "Spring Viremia of Carp (SVC)": 365,
  "Aeromonas Vaccine": 365
};

// Normalize intervals for case-insensitive lookup
const normalizedIntervals = {};
Object.keys(vaccineIntervals).forEach(k => {
  normalizedIntervals[k.toLowerCase()] = vaccineIntervals[k];
});

// Helper to send reminder using existing transporter
function sendReminderEmail(to, petName, vaccineType, vaccineDate) {
  if (!to) {
    console.log("No recipient provided for reminder", petName, vaccineType, vaccineDate);
    return;
  }

  const mailOptions = {
    from: process.env.MAIL_USER,
    to,
    subject: `Vaccination Reminder for ${petName}`,
    text: `Hello,\n\nThis is a reminder that your pet "${petName}" needs the "${vaccineType}" vaccine on ${vaccineDate}.\n\nRegards,\nPawPalace`
  };

  transporter.sendMail(mailOptions, (err, info) => {
    if (err) return console.error("❌ Email failed:", err);
    console.log("✅ Reminder email sent:", info.response, "to", to);
  });
}

// ----------------------
// Helper: remove duplicate vaccinations (case-insensitive) and normalize shape
// Accepts array of { vaccineType, date } where vaccineType is string
// ----------------------
function dedupeVaccinationsArray(vaccinations = []) {
  const seen = new Set();
  const unique = [];

  for (const v of vaccinations) {
    if (!v || !v.vaccineType) continue;
    const key = String(v.vaccineType).trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      // store original casing as provided, but ensure date exists (leave validation to caller)
      unique.push({ vaccineType: String(v.vaccineType).trim(), date: v.date });
    }
  }
  return unique;
}

// Main run
async function run() {
  try {
    await client.connect();

    // Collections
    const userCollection = client.db('pawpalaceDB').collection('user');
    const petCollection = client.db("pawpalaceDB").collection("pet");
    const adoptionCollection = client.db("pawpalaceDB").collection("adoptionRequest");
    const donationCollection = client.db("pawpalaceDB").collection("donates");
    const donatesCollection = client.db("pawpalaceDB").collection("donations");
    const purchasesCollection = client.db("pawpalaceDB").collection("purchases");

    // ======================
    // Vaccination Reminder Setup (uses normalizedIntervals)
    // ======================
    async function sendVaccinationReminders() {
      try {
        // We want to notify for vaccines due tomorrow (1 day before)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        const dayAfterTomorrow = new Date(tomorrow);
        dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);
        const dayAfterTomorrowStr = dayAfterTomorrow.toISOString().split('T')[0];

        // Find pets that have vaccinations array
        const pets = await petCollection.find({
          vaccinations: { $exists: true, $ne: [] }
        }).toArray();

        for (const pet of pets) {
          // For each defined vaccine type interval
          for (const [vaccineKeyLower, intervalDays] of Object.entries(normalizedIntervals)) {
            // Find all entries for this vaccine type (case-insensitive)
            const entriesForType = (pet.vaccinations || []).filter(v => {
              if (!v || !v.vaccineType || !v.date) return false;
              return String(v.vaccineType).trim().toLowerCase() === vaccineKeyLower;
            });

            if (!entriesForType.length) continue;

            // Get the latest given vaccination for this type
            const latestForType = entriesForType.reduce((latest, current) => {
              return new Date(current.date) > new Date(latest.date) ? current : latest;
            }, entriesForType[0]);

            const lastDate = new Date(latestForType.date);
            if (isNaN(lastDate.getTime())) continue;

            // Next due date for this vaccine type
            const nextDueDate = new Date(lastDate);
            nextDueDate.setDate(nextDueDate.getDate() + intervalDays);
            const nextDueDateStr = nextDueDate.toISOString().split('T')[0];

            // If next due date is tomorrow (within the next day window)
            if (nextDueDateStr >= tomorrowStr && nextDueDateStr < dayAfterTomorrowStr) {
              // 1) Notify accepted adopter (if exists)
              const adoption = await adoptionCollection.findOne({
                petId: pet._id.toString(),
                status: 'accepted'
              });

              if (adoption?.adopterEmail) {
                sendReminderEmail(
                  adoption.adopterEmail,
                  pet.pet_name,
                  latestForType.vaccineType,
                  nextDueDateStr
                );
                console.log(`Reminder queued for adopter ${adoption.adopterEmail} for pet ${pet.pet_name} vaccine ${latestForType.vaccineType} due ${nextDueDateStr}`);
              } else {
                console.log(`No accepted adopter found for pet ${pet.pet_name} (vaccine: ${latestForType.vaccineType})`);
              }

              // 2) Notify buyer (if pet was sold and purchase record exists)
              const purchase = await purchasesCollection.findOne({
                petId: pet._id.toString()
              });

              if (purchase?.buyerEmail) {
                sendReminderEmail(
                  purchase.buyerEmail,
                  pet.pet_name,
                  latestForType.vaccineType,
                  nextDueDateStr
                );
                console.log(`Reminder queued for buyer ${purchase.buyerEmail} for pet ${pet.pet_name} vaccine ${latestForType.vaccineType} due ${nextDueDateStr}`);
              } else {
                console.log(`No purchase record (buyer) to notify for pet ${pet.pet_name} (vaccine: ${latestForType.vaccineType})`);
              }
            }
          }
        }
      } catch (error) {
        console.error("Error in sending vaccination reminders:", error);
      }
    }

    // Run once at server startup (optional but helpful)
    sendVaccinationReminders()
      .then(() => console.log("Initial vaccination reminders check completed"))
      .catch(err => console.error("Initial reminder check failed:", err));

    // Schedule the job with node-cron (daily at 09:00 server time)
    cron.schedule("0 9 * * *", async () => {
      console.log("Scheduled vaccination reminders running at", new Date().toISOString());
      try {
        await sendVaccinationReminders();
      } catch (err) {
        console.error("Scheduled reminder error:", err);
      }
    });

    // Optional: manual test endpoint to trigger reminders immediately
    app.get('/test-send-vaccination-reminders', async (req, res) => {
      try {
        await sendVaccinationReminders();
        res.send({ success: true, message: "Vaccination reminder task executed (manual run)." });
      } catch (error) {
        console.error("Manual reminder run failed:", error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // newly added testing email endpoint (keeps your previous behavior)
    app.post('/send-test-email', async (req, res) => {
      const { to, subject, message } = req.body;
      try {
        await transporter.sendMail({ from: process.env.MAIL_USER, to, subject, text: message });
        res.send({ success: true, message: 'Email sent successfully' });
      } catch (error) {
        res.status(500).send({ success: false, error: error.message });
      }
    });

    // ======================
    // JWT Authentication
    // ======================
    app.post('/jwt', async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '30d' });
      res.send({ token });
    });

    const verifyToken = (req, res, next) => {
      if (!req.headers.authorization) return res.status(401).send({ message: 'unauthorized access' });
      const token = req.headers.authorization.split(' ')[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) return res.status(401).send({ message: 'unauthorized access' });
        req.decoded = decoded;
        next();
      });
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await userCollection.findOne({ email });
      const isAdmin = user?.role === 'admin';
      if (!isAdmin) return res.status(403).send({ message: 'forbidden access' });
      next();
    };

    // ======================
    // Users Endpoints
    // ======================
    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      const users = await userCollection.find().toArray();
      res.send(users);
    });

    app.get('/users/admin/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) return res.status(403).send({ message: 'forbidden access' });
      const user = await userCollection.findOne({ email });
      res.send({ admin: user?.role === 'admin' });
    });

    app.post('/users', async (req, res) => {
      const user = req.body;
      const existingUser = await userCollection.findOne({ email: user.email });
      if (existingUser) return res.send({ message: "user already exists", insertedId: null });
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.patch('/users/admin/:id', async (req, res) => {
      const id = req.params.id;
      const result = await userCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role: 'admin' } }
      );
      res.send(result);
    });

    app.delete('/users/:id', async (req, res) => {
      const id = req.params.id;
      const result = await userCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // ======================
    // Pets Endpoints
    // ======================

    app.post('/pet', async (req, res) => {
      try {
        const petData = req.body;

        // ✅ Validate price if purpose is 'sell'
        if (petData.purpose === 'sell') {
          if (petData.price === undefined || isNaN(Number(petData.price)) || Number(petData.price) <= 0) {
            return res.status(400).send({ message: "Price must be a positive number when purpose is 'sell'" });
          }
          petData.price = Number(petData.price);  // ✅ Force price to be a Number
        }

        // Ensure vaccinations array shape & remove duplicates (server-side safety)
        if (petData.vaccinations && Array.isArray(petData.vaccinations)) {
          petData.vaccinations = dedupeVaccinationsArray(petData.vaccinations);
        } else {
          petData.vaccinations = [];
        }

        const pet = {
          ...petData,
          status: 'pending',
          adopted: false,
          dateAdded: new Date().toISOString(),
        };

        if (!pet.purpose) pet.purpose = 'pet';

        const result = await petCollection.insertOne(pet);
        res.send(result);
      } catch (error) {
        console.error("Error adding pet:", error);
        res.status(500).send({ message: "Failed to add pet", error: error.message });
      }
    });

    app.get('/pets', async (req, res) => {
      try {
        const { purpose } = req.query;
        const query = { status: 'approved' };
        if (purpose) query.purpose = purpose;
        const pets = await petCollection.find(query).toArray();
        res.send(pets);
      } catch (error) {
        console.error("Error fetching pets:", error);
        res.status(500).send({ message: "Failed to fetch pets", error: error.message });
      }
    });

    app.get('/pets/pending', verifyToken, verifyAdmin, async (req, res) => {
      const pending = await petCollection.find({ status: 'pending' }).toArray();
      res.send(pending);
    });

    app.put('/pet/approve/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await petCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'approved' } }
      );
      res.send({ success: result.modifiedCount > 0 });
    });

    app.put('/pet/reject/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await petCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'rejected' } }
      );
      res.send({ success: result.modifiedCount > 0 });
    });

    app.get('/pet/:id', async (req, res) => {
      const id = req.params.id;
      const result = await petCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // Toggle adopted (admin)
    app.put('/pet/toggleAdoption/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await petCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { adopted: req.body.adopted } }
      );
      res.send(result);
    });

    // Pets by owner email
    app.get('/pets/:email', async (req, res) => {
      const email = req.params.email;
      const result = await petCollection.find({ email }).toArray();
      res.send(result);
    });

    // Mark a pet as adopted
    app.put('/pet/adopted/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: { adopted: true }
        };

        const result = await petCollection.updateOne(query, updateDoc);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to update pet adoption status." });
      }
    });

    // Update whole pet
    app.patch('/updatePet/:id', async (req, res) => {
      const id = req.params.id;
      const petData = req.body;

      // server-side deduplication for vaccinations if present
      if (petData.vaccinations && Array.isArray(petData.vaccinations)) {
        petData.vaccinations = dedupeVaccinationsArray(petData.vaccinations);
      }

      const result = await petCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { ...petData } }
      );
      res.send(result);
    });

    // Update only vaccinations
    app.patch('/pet/:id/vaccinations', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { vaccinations } = req.body; // expects array of {vaccineType, date}
      if (!Array.isArray(vaccinations)) return res.status(400).send({ message: 'Invalid vaccinations array' });

      // dedupe server-side
      const cleaned = dedupeVaccinationsArray(vaccinations);

      const result = await petCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { vaccinations: cleaned } }
      );
      res.send(result);
    });

    app.delete('/pet/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await petCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // ======================
    // Adoption Endpoints
    // ======================
    app.post('/adoption', async (req, res) => {
      const adoption = req.body;
      const result = await adoptionCollection.insertOne(adoption);
      res.send(result);
    });

    app.get('/adoption-requests/:email', async (req, res) => {
      const email = req.params.email;
      const result = await adoptionCollection.find({ ownerEmail: email }).toArray();
      res.send(result);
    });

    // Adoption request accept
    app.put('/adoption/accept/:id', async (req, res) => {
      try {
        const adoptionRequestId = req.params.id;

        // 1) Find the adoption request
        const requestDoc = await adoptionCollection.findOne({
          _id: new ObjectId(adoptionRequestId)
        });
        if (!requestDoc) {
          return res.status(404).send({
            success: false,
            message: 'Adoption request not found'
          });
        }

        const petId = requestDoc.petId;
        if (!petId || !ObjectId.isValid(petId)) {
          return res.status(400).send({
            success: false,
            message: 'Invalid petId in adoption request'
          });
        }

        // 2) Mark THIS adoption request as accepted
        const updatedRequest = await adoptionCollection.updateOne(
          { _id: new ObjectId(adoptionRequestId) },
          {
            $set: {
              adopted: true,
              status: 'accepted',
              acceptedAt: new Date()
            }
          }
        );

        if (updatedRequest.modifiedCount === 0) {
          return res.status(500).send({
            success: false,
            message: 'Failed to update adoption request'
          });
        }

        // 3) Mark the pet as adopted
        const updatedPet = await petCollection.updateOne(
          { _id: new ObjectId(petId) },
          { $set: { adopted: true } }
        );

        if (updatedPet.modifiedCount === 0) {
          return res.status(500).send({
            success: false,
            message: 'Failed to mark pet as adopted'
          });
        }

        // 4) Close other requests for the same pet
        await adoptionCollection.updateMany(
          {
            petId,
            _id: { $ne: new ObjectId(adoptionRequestId) }
          },
          { $set: { status: 'closed' } }
        );

        return res.send({
          success: true,
          message: 'Adoption request accepted successfully',
          petUpdated: updatedPet.modifiedCount,
          requestUpdated: updatedRequest.modifiedCount
        });

      } catch (error) {
        console.error('ACCEPT ERROR:', error);
        return res.status(500).send({
          success: false,
          message: error.message || 'Server error'
        });
      }
    });

    app.delete('/adoption/reject/:id', async (req, res) => {
      const id = req.params.id;
      const result = await adoptionCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // ======================
    // Donations Endpoints
    // ======================
    app.post('/donation-camp', async (req, res) => {
      const donation = req.body;
      const result = await donationCollection.insertOne(donation);
      res.send(result);
    });

    app.get('/donation-camps', async (req, res) => {
      const result = await donationCollection.find().toArray();
      res.send(result);
    });

    app.delete('/donation-camp/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await donationCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.get('/donation-camps/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      const result = await donationCollection.find({ email }).toArray();
      res.send(result);
    });

    app.patch('/donation-camp/pause/:id', async (req, res) => {
      const id = req.params.id;
      const result = await donationCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { pause: true } }
      );
      res.send(result);
    });

    app.patch('/donation-camp/unpause/:id', async (req, res) => {
      const id = req.params.id;
      const result = await donationCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { pause: false } }
      );
      res.send(result);
    });

    app.get('/donation-camps/donators/:postId', async (req, res) => {
      const postId = req.params.postId;
      const result = await donatesCollection.find({ postId }).toArray();
      res.send(result);
    });

    app.get('/donation-camp/:id', async (req, res) => {
      const id = req.params.id;
      const result = await donationCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.patch('/updateDonation-camp/:id', async (req, res) => {
      const id = req.params.id;
      const donationData = req.body;
      const result = await donationCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { ...donationData } }
      );
      res.send(result);
    });

    // ======================
    // Payments
    // ======================
    app.post('/create-payment-intent', async (req, res) => {
      const { donate } = req.body;
      const amount = parseInt(donate * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        payment_method_types: ['card']
      });
      res.send({ clientSecret: paymentIntent.client_secret });
    });

    app.post('/donates', async (req, res) => {
      const donates = req.body;
      const { postId, donatedAmount } = donates;
      const result = await donatesCollection.insertOne(donates);
      const updateResult = await donationCollection.updateOne(
        { _id: new ObjectId(postId) },
        { $inc: { donatedAmount: donatedAmount } }
      );
      res.send({ result, updateResult });
    });

    app.post('/purchases', async (req, res) => {
      try {
        const purchase = req.body;

        // Save purchase
        const result = await purchasesCollection.insertOne(purchase);

        // Optional: mark the pet as sold
        await petCollection.updateOne(
          { _id: new ObjectId(purchase.petId) },
          { $set: { sold: true } }
        );

        res.send(result);
      } catch (error) {
        console.error("Purchase error:", error);
        res.status(500).send({ message: "Failed to save purchase", error: error.message });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB connected!");
  } finally {
    // Not closing client to keep server running
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("PawPalace server running");
});

// app.listen(port, () => {
//   console.log(`Server running on port: ${port}`);
// });
// ✅ Export for Vercel Serverless Functions
module.exports = app;

// ✅ Run locally only
// if (require.main === module) {
//   const port = 5000;
//   app.listen(port, () => {
//     console.log(`Server running on port ${port}`);
//   });
// }

