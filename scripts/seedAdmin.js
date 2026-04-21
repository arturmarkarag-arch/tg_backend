require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function seedAdmin() {
  await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const telegramId = '926546988';
  const adminData = {
    telegramId,
    role: 'admin',
    firstName: 'Admin',
    lastName: '',
    phoneNumber: '',
    shopNumber: '',
    shopName: '',
    shopAddress: '',
    shopCity: '',
    deliveryGroupId: '',
    warehouseZone: '',
    botBlocked: false,
    isOnline: false,
  };

  let user = await User.findOne({ telegramId });
  if (!user) {
    user = new User(adminData);
    await user.save();
    console.log('Admin user created:', user);
  } else {
    console.log('Admin user already exists:', user);
  }

  await mongoose.disconnect();
}

seedAdmin().catch(e => {
  console.error(e);
  process.exit(1);
});
