import axios from 'axios';

async function test() {
    try {
        const { data } = await axios.get('https://tikwm.com/api?url=https://vm.tiktok.com/ZMH75QxRcoAmA-f5GEM/');
        console.log(JSON.stringify(data.data, null, 2));
    } catch (e) {
        console.log('Error:', e.message);
    }
}

test();